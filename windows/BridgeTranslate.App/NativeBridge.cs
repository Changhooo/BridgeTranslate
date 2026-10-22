using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;
using BridgeTranslate.Core;
namespace BridgeTranslate.App;
public sealed record WindowChoice(nint Handle,int ProcessId,string Title){public override string ToString()=>Title+" · PID "+ProcessId;}
public sealed record ControlChoice(AutomationElement Element,string Label){public override string ToString()=>Label;}
public sealed class NativeBridge {
 public WindowChoice? Target {get;private set;}
 public ControlChoice? Editor {get;private set;}
 public ControlChoice? Send {get;private set;}
 public ControlChoice? Answer {get;private set;}
 private string lastFilled="";
 public static IReadOnlyList<WindowChoice> Windows(){var list=new List<WindowChoice>();EnumWindows((h,_)=>{if(!IsWindowVisible(h))return true;GetWindowThreadProcessId(h,out var pid);try{using var p=Process.GetProcessById((int)pid);if(!p.ProcessName.Contains("claude",StringComparison.OrdinalIgnoreCase))return true;var b=new StringBuilder(512);GetWindowText(h,b,b.Capacity);if(b.Length>0)list.Add(new(h,(int)pid,b.ToString()));}catch{}return true;},0);return list;}
 public void Bind(WindowChoice w){if(!IsWindow(w.Handle))throw new InvalidOperationException("窗口已关闭，请重新选择。");Target=w;Editor=null;Send=null;Answer=null;lastFilled="";}
 private AutomationElement Root(){if(Target==null||!IsWindow(Target.Handle))throw new InvalidOperationException("请先连接 CC 窗口。");GetWindowThreadProcessId(Target.Handle,out var pid);if(pid!=Target.ProcessId)throw new InvalidOperationException("窗口身份已改变，请重新连接。");return AutomationElement.FromHandle(Target.Handle);}
 public List<ControlChoice> Controls(string kind){var root=Root();var all=root.FindAll(TreeScope.Descendants,Condition.TrueCondition);var result=new List<ControlChoice>();
  foreach(AutomationElement e in all){try{
   if(e.Current.IsOffscreen||!e.Current.IsEnabled||e.Current.IsPassword)continue;
   var type=e.Current.ControlType;bool ok=kind=="send"?type==ControlType.Button&&e.TryGetCurrentPattern(InvokePattern.Pattern,out _):kind=="editor"?(type==ControlType.Edit||type==ControlType.Document)&&(e.TryGetCurrentPattern(ValuePattern.Pattern,out _)||e.TryGetCurrentPattern(TextPattern.Pattern,out _)):e.TryGetCurrentPattern(TextPattern.Pattern,out _)&&type!=ControlType.Edit;
   if(!ok)continue;var b=e.Current.BoundingRectangle;if(b.Width<8||b.Height<8)continue;var sample=Read(e);if(sample.Length>65)sample=sample[..65]+"…";var name=e.Current.Name;
   result.Add(new(e,$"{name} [{type.ProgrammaticName.Replace("ControlType.","")}] {Math.Round(b.Width)}×{Math.Round(b.Height)} · {sample.Replace('\n',' ')}"));
   if(result.Count>=100)break;
  }catch{}}
  return result;
 }
 public void Select(string kind,ControlChoice c){EnsureInside(c.Element);if(kind=="editor"){Editor=c;lastFilled="";}else if(kind=="send")Send=c;else Answer=c;}
 private void EnsureInside(AutomationElement e){var root=Root();var p=e;for(var i=0;i<70&&p!=null;i++){if(Automation.Compare(p,root))return;p=TreeWalker.RawViewWalker.GetParent(p);}throw new InvalidOperationException("控件不在绑定窗口内，请重新绑定。");}
 public static string Read(AutomationElement e){try{if(e.TryGetCurrentPattern(ValuePattern.Pattern,out var v))return ((ValuePattern)v).Current.Value.TrimEnd('\r','\n');if(e.TryGetCurrentPattern(TextPattern.Pattern,out var t))return ((TextPattern)t).DocumentRange.GetText(60001).TrimEnd('\r','\n');}catch{}return "";}
 public string CaptureStamp(){if(Editor==null)throw new InvalidOperationException("请绑定 CC 输入框。");EnsureInside(Editor.Element);var b=new StringBuilder(512);GetWindowText(Target!.Handle,b,b.Capacity);return Target.Handle+"|"+Target.ProcessId+"|"+b+"|"+string.Join(',',Editor.Element.GetRuntimeId());}
 public async Task FillAsync(string english,string stamp,bool send,Func<string,Task> setClipboard,CancellationToken ct){
  if(string.IsNullOrWhiteSpace(english)||TranslationRules.HasHan(english))throw new InvalidOperationException("待填入文本为空或仍含汉字。");
  if(CaptureStamp()!=stamp)throw new InvalidOperationException("目标窗口或输入框已改变，未填入。");
  var editor=Editor!.Element;if(editor.Current.IsPassword)throw new InvalidOperationException("不能向密码控件填入提问。");var previous=Read(editor);if(previous.Length>0&&previous!=lastFilled)throw new InvalidOperationException("CC 输入框已有其他草稿，未覆盖。请自行清空后重试。");
  ct.ThrowIfCancellationRequested();
  if(editor.TryGetCurrentPattern(ValuePattern.Pattern,out var value)&&!((ValuePattern)value).Current.IsReadOnly)((ValuePattern)value).SetValue(english);
  else{
   if(previous.Length>0)throw new InvalidOperationException("该输入框不能直接替换已有内容，请先清空。");
   if(!SetForegroundWindow(Target!.Handle))throw new InvalidOperationException("未能激活 CC，未发送按键。可手动复制英文。");
   editor.SetFocus();await Task.Delay(160,ct);EnsureFocused(editor);
   await setClipboard(english);ct.ThrowIfCancellationRequested();EnsureFocused(editor);Paste();
  }
  await Task.Delay(220,ct);if(CaptureStamp()!=stamp||Read(editor).Trim()!=english.Trim())throw new InvalidOperationException("CC 未接受完整英文，未自动发送。请核对输入框。");
  lastFilled=english.TrimEnd('\r','\n');
  if(!send)return;
  if(Send==null)throw new InvalidOperationException("英文已填入；未绑定发送按钮，请手动发送。");EnsureInside(Send.Element);
  if(!Send.Element.Current.IsEnabled||Send.Element.Current.IsOffscreen)throw new InvalidOperationException("英文已填入；发送按钮不可用。");
  ct.ThrowIfCancellationRequested();if(CaptureStamp()!=stamp||Read(editor).Trim()!=english.Trim())throw new InvalidOperationException("发送前内容改变，已停止。");
  if(!Send.Element.TryGetCurrentPattern(InvokePattern.Pattern,out var invoke))throw new InvalidOperationException("按钮不支持原生调用，请手动发送。");
  ((InvokePattern)invoke).Invoke(); // Exactly once. Never retries or synthesizes Enter.
  await Task.Delay(350,CancellationToken.None);if(Read(editor).Trim()==english.Trim())throw new InvalidOperationException("已点击一次发送，但未确认成功。请查看 CC 会话，勿直接重复发送。");
  lastFilled="";
 }
 private void EnsureFocused(AutomationElement e){if(GetForegroundWindow()!=Target!.Handle||!Automation.Compare(AutomationElement.FocusedElement,e))throw new InvalidOperationException("焦点已改变，未发送粘贴按键。");}
 public string ReadAnswer(){if(Answer==null)throw new InvalidOperationException("尚未绑定回答区域。");EnsureInside(Answer.Element);return Read(Answer.Element);}
 private static void Paste(){INPUT Key(ushort key,uint flags)=>new(){type=1,u=new InputUnion{ki=new KEYBDINPUT{wVk=key,dwFlags=flags}}};var a=new[]{Key(0x11,0),Key(0x56,0),Key(0x56,2),Key(0x11,2)};if(SendInput((uint)a.Length,a,Marshal.SizeOf<INPUT>())!=a.Length)throw new InvalidOperationException("系统未接受粘贴按键。");}
 [StructLayout(LayoutKind.Sequential)]private struct INPUT{public uint type;public InputUnion u;}
 [StructLayout(LayoutKind.Explicit)]private struct InputUnion{[FieldOffset(0)]public KEYBDINPUT ki;[FieldOffset(0)]public MOUSEINPUT mi;}
 [StructLayout(LayoutKind.Sequential)]private struct KEYBDINPUT{public ushort wVk,wScan;public uint dwFlags,time;public nuint dwExtraInfo;}
 [StructLayout(LayoutKind.Sequential)]private struct MOUSEINPUT{public int dx,dy;public uint mouseData,dwFlags,time;public nuint dwExtraInfo;}
 private delegate bool EnumWindowProc(nint h,nint param);
 [DllImport("user32.dll")]private static extern bool EnumWindows(EnumWindowProc callback,nint param);
 [DllImport("user32.dll")]private static extern bool IsWindowVisible(nint h);
 [DllImport("user32.dll")]private static extern bool IsWindow(nint h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]private static extern int GetWindowText(nint h,StringBuilder value,int max);
 [DllImport("user32.dll")]private static extern uint GetWindowThreadProcessId(nint h,out uint pid);
 [DllImport("user32.dll")]private static extern bool SetForegroundWindow(nint h);
 [DllImport("user32.dll")]private static extern nint GetForegroundWindow();
 [DllImport("user32.dll")]private static extern uint SendInput(uint count,INPUT[] inputs,int size);
}
