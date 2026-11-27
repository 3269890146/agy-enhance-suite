<#
文件职责：Antigravity 桌宠 Windows 原生 60fps 窗口跟随引擎（常驻后台辅助脚本）
项目角色：由 `src/main.js` 在开启「跟随 Antigravity 窗口」时拉起并传入猫娘 `BrowserWindow` 的原生窗口句柄 (`-PetHwnd`)。
核心原理：
  1. 通过一次 C# 编译与 WinForms 消息循环常驻内存（0 次重复冷启动），彻底消除原本每 2.5 秒启停 PowerShell 造成的拖动延迟；
  2. 使用 Win32 `SetWindowLongPtr(GWLP_HWNDPARENT)` 将猫娘窗口绑定为 Antigravity 主窗口的 Owned Window，并摘除全局置顶：
     - Antigravity 最小化/还原时，猫娘瞬间同步隐藏/恢复；
     - 切换到其他软件（如浏览器、微信）时，猫娘自动被其他窗口盖在后面，只待在 Antigravity 窗口里；
  3. 使用 `SetWinEventHook` 精准监听 Antigravity 主进程窗口位置与大小变化（`EVENT_OBJECT_LOCATIONCHANGE` / `MINIMIZESTART` / `MINIMIZEEND`），在纯物理像素空间（`DwmGetWindowAttribute` + `SetWindowPos`）实现 60fps 零 DPI 偏差丝滑跟手。
#>
param(
  [Parameter(Mandatory = $true)]
  [Int64]$PetHwnd,
  [switch]$DetachOnly
)

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class AgyPetWinFollower {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  private delegate void WinEventDelegate(
    IntPtr hWinEventHook,
    uint eventType,
    IntPtr hwnd,
    int idObject,
    int idChild,
    uint dwEventThread,
    uint dwmsEventTime
  );

  private const int GWLP_HWNDPARENT = -8;
  private const int GWL_EXSTYLE = -20;
  private const long WS_EX_TOPMOST = 0x00000008L;

  private const uint SWP_NOSIZE = 0x0001;
  private const uint SWP_NOMOVE = 0x0002;
  private const uint SWP_NOZORDER = 0x0004;
  private const uint SWP_NOACTIVATE = 0x0010;
  private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

  private const int SW_HIDE = 0;
  private const int SW_SHOWNOACTIVATE = 4;

  private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

  private const uint EVENT_OBJECT_DESTROY = 0x8001;
  private const uint EVENT_OBJECT_SHOW = 0x8002;
  private const uint EVENT_OBJECT_HIDE = 0x8003;
  private const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
  private const uint EVENT_SYSTEM_MINIMIZESTART = 0x0016;
  private const uint EVENT_SYSTEM_MINIMIZEEND = 0x0017;
  private const uint WINEVENT_OUTOFCONTEXT = 0x0000;

  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
  [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
  [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc, WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);
  [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hWinEventHook);

  private static IntPtr SetOwnerPtr(IntPtr hWnd, IntPtr owner) {
    if (IntPtr.Size == 8) return SetWindowLongPtr64(hWnd, GWLP_HWNDPARENT, owner);
    return new IntPtr(SetWindowLong32(hWnd, GWLP_HWNDPARENT, owner.ToInt32()));
  }

  private static long GetExStyle(IntPtr hWnd) {
    if (IntPtr.Size == 8) return GetWindowLongPtr64(hWnd, GWL_EXSTYLE).ToInt64();
    return GetWindowLong32(hWnd, GWL_EXSTYLE);
  }

  private readonly IntPtr _petHwnd;
  private IntPtr _agyHwnd = IntPtr.Zero;
  private uint _agyPid = 0;
  private IntPtr _hookLoc = IntPtr.Zero;
  private IntPtr _hookMin = IntPtr.Zero;
  private WinEventDelegate _eventProc;
  private System.Windows.Forms.Timer _watchdog;

  public AgyPetWinFollower(IntPtr petHwnd) {
    _petHwnd = petHwnd;
    _eventProc = new WinEventDelegate(OnWinEvent);
  }

  private static IntPtr FindAntigravityHwnd(out uint foundPid) {
    foundPid = 0;
    try {
      Process[] procs = Process.GetProcessesByName("Antigravity");
      foreach (Process p in procs) {
        try {
          IntPtr h = p.MainWindowHandle;
          if (h != IntPtr.Zero && IsWindow(h) && (IsWindowVisible(h) || IsIconic(h))) {
            foundPid = (uint)p.Id;
            return h;
          }
        } catch { }
      }
    } catch { }
    return IntPtr.Zero;
  }

  private static bool TryGetPhysicalBounds(IntPtr hwnd, out RECT rect) {
    int hr = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT)));
    if (hr == 0 && rect.Right > rect.Left && rect.Bottom > rect.Top) {
      return true;
    }
    return GetWindowRect(hwnd, out rect) && rect.Right > rect.Left && rect.Bottom > rect.Top;
  }

  private void UnhookAll() {
    if (_hookLoc != IntPtr.Zero) {
      UnhookWinEvent(_hookLoc);
      _hookLoc = IntPtr.Zero;
    }
    if (_hookMin != IntPtr.Zero) {
      UnhookWinEvent(_hookMin);
      _hookMin = IntPtr.Zero;
    }
  }

  private void AttachTarget(IntPtr targetHwnd, uint targetPid) {
    if (_agyHwnd == targetHwnd && _agyPid == targetPid && _hookLoc != IntPtr.Zero) {
      return;
    }
    UnhookAll();
    _agyHwnd = targetHwnd;
    _agyPid = targetPid;

    if (_agyHwnd == IntPtr.Zero || !IsWindow(_agyHwnd)) {
      return;
    }

    // 绑定 Owned Window 关系并摘除全局置顶，让猫娘只在 Antigravity 之上显示、切走即让位
    SetOwnerPtr(_petHwnd, _agyHwnd);
    if ((GetExStyle(_petHwnd) & WS_EX_TOPMOST) != 0) {
      SetWindowPos(_petHwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    _hookLoc = SetWinEventHook(
      EVENT_OBJECT_DESTROY,
      EVENT_OBJECT_LOCATIONCHANGE,
      IntPtr.Zero,
      _eventProc,
      _agyPid,
      0,
      WINEVENT_OUTOFCONTEXT
    );
    _hookMin = SetWinEventHook(
      EVENT_SYSTEM_MINIMIZESTART,
      EVENT_SYSTEM_MINIMIZEEND,
      IntPtr.Zero,
      _eventProc,
      _agyPid,
      0,
      WINEVENT_OUTOFCONTEXT
    );
  }

  private void SyncPositionAndVisibility() {
    if (!IsWindow(_petHwnd)) {
      Application.ExitThread();
      return;
    }

    if (_agyHwnd == IntPtr.Zero || !IsWindow(_agyHwnd)) {
      uint pid;
      IntPtr found = FindAntigravityHwnd(out pid);
      if (found != IntPtr.Zero) {
        AttachTarget(found, pid);
      } else {
        UnhookAll();
        _agyHwnd = IntPtr.Zero;
        _agyPid = 0;
        if (IsWindowVisible(_petHwnd)) {
          ShowWindow(_petHwnd, SW_HIDE);
        }
        return;
      }
    }

    if (IsIconic(_agyHwnd) || !IsWindowVisible(_agyHwnd)) {
      if (IsWindowVisible(_petHwnd)) {
        ShowWindow(_petHwnd, SW_HIDE);
      }
      return;
    }

    RECT agyRect;
    if (!TryGetPhysicalBounds(_agyHwnd, out agyRect)) {
      return;
    }

    RECT petRect;
    if (!GetWindowRect(_petHwnd, out petRect)) {
      return;
    }
    int petW = petRect.Right - petRect.Left;
    int petH = petRect.Bottom - petRect.Top;
    if (petW <= 10 || petH <= 10) {
      return;
    }

    // 停靠在 Antigravity 主窗口右下角内侧（纯物理像素空间，不受 125%/150% DPI 缩放偏移影响）
    int targetX = agyRect.Right - petW - 14;
    int targetY = agyRect.Bottom - petH - 10;

    if ((GetExStyle(_petHwnd) & WS_EX_TOPMOST) != 0) {
      SetWindowPos(_petHwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    if (petRect.Left != targetX || petRect.Top != targetY) {
      SetWindowPos(_petHwnd, IntPtr.Zero, targetX, targetY, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }

    if (!IsWindowVisible(_petHwnd)) {
      ShowWindow(_petHwnd, SW_SHOWNOACTIVATE);
    }
  }

  private void OnWinEvent(
    IntPtr hWinEventHook,
    uint eventType,
    IntPtr hwnd,
    int idObject,
    int idChild,
    uint dwEventThread,
    uint dwmsEventTime
  ) {
    if (idObject != 0 || idChild != 0) return;
    if (hwnd != _agyHwnd && eventType != EVENT_OBJECT_SHOW) return;

    if (eventType == EVENT_OBJECT_DESTROY && hwnd == _agyHwnd) {
      _agyHwnd = IntPtr.Zero;
    }
    SyncPositionAndVisibility();
  }

  public static void DetachOwner(IntPtr petHwnd) {
    if (petHwnd != IntPtr.Zero && IsWindow(petHwnd)) {
      SetOwnerPtr(petHwnd, IntPtr.Zero);
      if (!IsWindowVisible(petHwnd)) {
        ShowWindow(petHwnd, SW_SHOWNOACTIVATE);
      }
    }
  }

  public void Run() {
    _watchdog = new System.Windows.Forms.Timer();
    _watchdog.Interval = 900;
    _watchdog.Tick += (s, e) => SyncPositionAndVisibility();
    _watchdog.Start();

    SyncPositionAndVisibility();
    try {
      Application.Run();
    } finally {
      _watchdog.Stop();
      _watchdog.Dispose();
      UnhookAll();
      if (IsWindow(_petHwnd)) {
        SetOwnerPtr(_petHwnd, IntPtr.Zero);
      }
    }
  }
}
"@

if ($DetachOnly) {
  [AgyPetWinFollower]::DetachOwner([IntPtr]$PetHwnd)
  return
}

$follower = New-Object AgyPetWinFollower([IntPtr]$PetHwnd)
$follower.Run()
