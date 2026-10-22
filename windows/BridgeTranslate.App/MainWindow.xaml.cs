using System.Net.Http;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using BridgeTranslate.Core;
using Markdig;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;
namespace BridgeTranslate.App;
public partial class MainWindow : Window {
 private readonly NativeBridge bridge=new();private readonly TranslationClient client=new();private readonly SessionFollower follower=new();
 private readonly DispatcherTimer poll=new(){Interval=TimeSpan.FromMilliseconds(700)};
 private ApiSettings settings=new();private ReplyState? reply;private CancellationTokenSource replyCts=new(),promptCts=new();
 private bool promptBusy,pollBusy,webReady,closed,followInterface,promptAuto;private string promptOriginal="",displayed="",session="";
 public MainWindow(){InitializeComponent();ChineseBox.TextChanged+=(_,_)=>{if(promptBusy&&ChineseBox.Text!=promptOriginal)promptCts.Cancel();};AutoSendBox.Unchecked+=(_,_)=>{if(promptBusy&&promptAuto)promptCts.Cancel();};poll.Tick+=async(_,_)=>await Poll();}
 private void Status(string s)=>StatusLabel.Text=s;
 private ApiSettings Form(){var c=new ApiSettings{Protocol=(ProtocolBox.SelectedItem as ComboBoxItem)?.Tag?.ToString()??"chat",Endpoint=EndpointBox.Text.Trim(),Model=ModelBox.Text.Trim(),Auth=(AuthBox.SelectedItem as ComboBoxItem)?.Tag?.ToString()??"auto",Key=KeyBox.Password,Glossary=GlossaryBox.Text,MaxTokens=4096,AutoSend=AutoSendBox.IsChecked==true,AutoReply=AutoReplyBox.IsChecked==true};TranslationRules.Endpoint(c);return c;}
 private async void Window_Loaded(object sender,RoutedEventArgs e){
  try{settings=SettingsStore.Load();EndpointBox.Text=settings.Endpoint;ModelBox.Text=settings.Model;KeyBox.Password=settings.Key;GlossaryBox.Text=settings.Glossary;foreach(ComboBoxItem item in ProtocolBox.Items)if(item.Tag?.ToString()==settings.Protocol)ProtocolBox.SelectedItem=item;foreach(ComboBoxItem item in AuthBox.Items)if(item.Tag?.ToString()==settings.Auth)AuthBox.SelectedItem=item;AutoSendBox.IsChecked=settings.AutoSend;AutoReplyBox.IsChecked=settings.AutoReply;}catch{Status("本机配置无法读取，请重新填写；原文件尚未覆盖。");}
  try{
   var environment=await CoreWebView2Environment.CreateAsync(null,Path.Combine(SettingsStore.DirectoryPath,"WebView"));await Reader.EnsureCoreWebView2Async(environment);
   Reader.CoreWebView2.Settings.AreDevToolsEnabled=false;Reader.CoreWebView2.Settings.AreDefaultContextMenusEnabled=true;Reader.CoreWebView2.Settings.AreHostObjectsAllowed=false;
   Reader.CoreWebView2.SetVirtualHostNameToFolderMapping("bridge.local",Path.Combine(AppContext.BaseDirectory,"Assets"),CoreWebView2HostResourceAccessKind.DenyCors);
   Reader.CoreWebView2.NavigationStarting+=(_,a)=>{if(!a.Uri.StartsWith("https://bridge.local/",StringComparison.Ordinal))a.Cancel=true;};
   Reader.CoreWebView2.NewWindowRequested+=(_,a)=>{a.Handled=true;};Reader.CoreWebView2.WebMessageReceived+=ReaderMessage;
   Reader.CoreWebView2.Navigate("https://bridge.local/index.html");
  }catch{Reader.Visibility=Visibility.Collapsed;FallbackReader.Visibility=Visibility.Visible;Status("阅读区使用纯 Markdown；安装 Microsoft WebView2 Runtime 后可显示完整排版。");}
  await RefreshWindows();poll.Start();
 }
 private async Task RefreshWindows(){try{var windows=await Task.Run(NativeBridge.Windows);WindowBox.ItemsSource=windows;if(windows.Count>0)WindowBox.SelectedIndex=0;}catch{Status("未读取到 CC 窗口，请手动刷新。");}}
 private async void RefreshWindows_Click(object s,RoutedEventArgs e)=>await RefreshWindows();
 private void Connect_Click(object s,RoutedEventArgs e){try{if(WindowBox.SelectedItem is not WindowChoice w)throw new InvalidOperationException("请先打开 CC 并选择窗口。");bridge.Bind(w);TargetLabel.Text="已连接："+w.Title+"。请确认是你要使用的 Code 会话，再绑定输入框。";Status("窗口已连接，尚未绑定输入框与发送按钮。");}catch(Exception x){Status(Safe(x));}}
 private async Task Bind(string kind){try{var choices=await Task.Run(()=>bridge.Controls(kind));if(choices.Count==0){Status("该窗口没有暴露所需的可访问控件；可使用复制英文或选择会话 JSONL。");return;}
  var picker=new Window{Owner=this,Title=kind=="editor"?"选择 CC 原提问框":kind=="send"?"选择 CC 原发送按钮":"选择可访问的回答文字区域",Width=790,Height=440,WindowStartupLocation=WindowStartupLocation.CenterOwner};
  var panel=new DockPanel{Margin=new Thickness(16)};var hint=new TextBlock{Text="按名称、尺寸与文字预览选择。不要选择搜索框、取消按钮或整个应用区域。",TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,0,0,12)};DockPanel.SetDock(hint,Dock.Top);panel.Children.Add(hint);
  var button=new Button{Content="绑定所选控件",HorizontalAlignment=HorizontalAlignment.Right};DockPanel.SetDock(button,Dock.Bottom);panel.Children.Add(button);var list=new ListBox{ItemsSource=choices,SelectedIndex=0};panel.Children.Add(list);picker.Content=panel;ControlChoice? selected=null;button.Click+=(_,_)=>{selected=list.SelectedItem as ControlChoice;picker.DialogResult=selected!=null;};
  if(picker.ShowDialog()==true&&selected!=null){await Task.Run(()=>bridge.Select(kind,selected));TargetLabel.Text="目标："+bridge.Target!.Title+"\n输入框："+(bridge.Editor?.Label??"未绑定")+"\n发送按钮："+(bridge.Send?.Label??"未绑定");if(kind=="answer"){followInterface=true;follower.Clear();session="";SourceLabel.Text="界面文字模式：仅跟随你绑定的控件，可能没有完整 Markdown。";}Status("已绑定。首次请先用“填入 CC”检查目标，再按需开启自动发送。");}
 }catch(Exception x){Status(Safe(x));}}
 private async void BindEditor_Click(object s,RoutedEventArgs e)=>await Bind("editor");private async void BindSend_Click(object s,RoutedEventArgs e)=>await Bind("send");private async void BindAnswer_Click(object s,RoutedEventArgs e)=>await Bind("answer");
 private async void Translate_Click(object s,RoutedEventArgs e)=>await TranslatePrompt(false);
 private async Task TranslatePrompt(bool auto){if(promptBusy){Status("提问正在处理中，请勿重复操作。");return;}promptBusy=true;promptAuto=auto;promptOriginal=ChineseBox.Text;promptCts.Dispose();promptCts=new();var token=promptCts.Token;string? stamp=null;
  try{var c=Form();if(string.IsNullOrWhiteSpace(promptOriginal))throw new InvalidOperationException("请先在桥译中输入中文。");if(auto){try{stamp=await Task.Run(bridge.CaptureStamp);}catch{stamp=null;}}Status("正在翻译提问…");var english=await client.TranslateAsync(c,promptOriginal,"en",token);token.ThrowIfCancellationRequested();if(ChineseBox.Text!=promptOriginal)throw new InvalidOperationException("中文草稿已改变，未覆盖英文预览或发送。");EnglishBox.Text=english;
   if(auto){if(stamp==null){Status("英文已生成；目标未绑定，未填入或发送。请连接 CC 后手动填入。");return;}if(AutoSendBox.IsChecked!=true)throw new OperationCanceledException();await Deliver(english,stamp!,true,token);}else Status("英文已生成。可检查、编辑，再填入 CC。");
  }catch(Exception x){Status(Safe(x));}finally{promptBusy=false;promptAuto=false;}
 }
 private async Task Deliver(string text,string stamp,bool send,CancellationToken token){
  await Task.Run(()=>bridge.FillAsync(text,stamp,send,value=>Dispatcher.InvokeAsync(()=>Clipboard.SetText(value)).Task,token),token);
  Status(send?"已触发一次 CC 发送，请在 CC 会话中确认结果。":"英文已填入 CC，尚未发送。");
 }
 private async Task Fill(bool send){if(promptBusy){Status("提问正在处理中，请等待或取消。");return;}promptBusy=true;promptCts.Dispose();promptCts=new();try{var en=EnglishBox.Text;var stamp=await Task.Run(bridge.CaptureStamp);await Deliver(en,stamp,send,promptCts.Token);}catch(Exception x){Status(Safe(x));}finally{promptBusy=false;}}
 private async void Fill_Click(object s,RoutedEventArgs e)=>await Fill(false);private async void Send_Click(object s,RoutedEventArgs e)=>await Fill(true);
 private void ChineseBox_KeyDown(object s,KeyEventArgs e){if(e.Key==Key.ImeProcessed)return;if(e.Key==Key.Enter&&Keyboard.Modifiers==ModifierKeys.None&&AutoSendBox.IsChecked==true){e.Handled=true;_ = TranslatePrompt(true);}}
 private void CopyEnglish_Click(object s,RoutedEventArgs e){try{if(EnglishBox.Text.Length>0){Clipboard.SetText(EnglishBox.Text);Status("英文已复制。");}}catch{Status("剪贴板暂不可用，请选中英文手动复制。");}}
 private void Cancel_Click(object s,RoutedEventArgs e){promptCts.Cancel();replyCts.Cancel();replyCts.Dispose();replyCts=new();reply?.Pending.Clear();AutoReplyBox.IsChecked=false;Status("已取消待处理操作并暂停回答翻译；已送达接口的请求可能仍计费。");}
 private void Save_Click(object s,RoutedEventArgs e){try{settings=Form();SettingsStore.Save(settings);Status("配置已保存，密钥使用当前 Windows 用户的系统加密保护。");}catch(Exception x){Status(Safe(x));}}
 private async void Test_Click(object s,RoutedEventArgs e){try{Status("正在测试当前表单…");await client.TranslateAsync(Form(),"Hello.","zh",CancellationToken.None);Status("当前配置连接成功；若需下次继续使用，请保存配置。");}catch(Exception x){Status(Safe(x));}}
 private void ClearKey_Click(object s,RoutedEventArgs e){try{KeyBox.Clear();settings.Key="";settings.ProtectedKey="";SettingsStore.Save(settings);Status("已删除本程序保存的密钥。");}catch{Status("密钥删除未完成，请重试。");}}
 private void Pin_Changed(object s,RoutedEventArgs e)=>Topmost=PinBox.IsChecked==true;
 private void ChooseFile_Click(object s,RoutedEventArgs e){var d=new OpenFileDialog{Title="选择当前本机 CC 会话 JSONL（只读）",Filter="会话 JSONL|*.jsonl|所有文件|*.*"};var folder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".claude","projects");if(Directory.Exists(folder))d.InitialDirectory=folder;
  if(d.ShowDialog()==true){replyCts.Cancel();replyCts.Dispose();replyCts=new();reply=null;session="";followInterface=false;follower.Select(d.FileName,true);SourceLabel.Text="只读跟随："+d.FileName;Status("已选择一个会话文件，只读取助手文字，不修改原记录。");}}
 private async Task Poll(){if(pollBusy||closed)return;pollBusy=true;try{
  if(followInterface){var text=await Task.Run(bridge.ReadAnswer);if(text.Length is >0 and <=60000)UpdateReply(new("uia", "",text,false));}
  else if(follower.Path!=null){var list=await follower.PollAsync(CancellationToken.None);var last=list.LastOrDefault(r=>session==""||r.Session==session);if(last!=null){if(session=="")session=last.Session;UpdateReply(last);}}
  if(reply!=null&&!reply.Complete&&DateTime.UtcNow-reply.LastChange>TimeSpan.FromSeconds(1.4)){reply.Complete=true;Render();}
  if(AutoReplyBox.IsChecked==true)QueueReply();
 }catch(Exception x){Status("回答读取暂停："+Safe(x));followInterface=false;follower.Clear();}finally{pollBusy=false;}}
 private void UpdateReply(AssistantRecord r){if(reply==null||reply.Id!=r.Id){replyCts.Cancel();replyCts.Dispose();replyCts=new();reply=new(){Id=r.Id};}if(reply.Update(r.Text,r.Complete))Render();}
 private void QueueReply(bool force=false){if(reply==null||(!force&&AutoReplyBox.IsChecked!=true))return;ApiSettings c;try{c=Form();if(c.Auth!="none"&&c.Key=="")return;}catch{return;}
  var state=reply;var revision=state.Revision;var token=replyCts.Token;
  foreach(var part in state.Parts){if(part.Keep||!part.Closed||!part.Text.Any(ch=>ch<=127&&char.IsLetter(ch))||state.Translations.ContainsKey(part.Text)||state.Pending.Contains(part.Text)||state.Failed.Contains(part.Text))continue;state.Pending.Add(part.Text);_ = TranslatePart(state,revision,c,part.Text,token);}
  ProgressLabel.Text=$"已译 {state.Translations.Count} 段 · 处理中 {state.Pending.Count}";
 }
 private async Task TranslatePart(ReplyState state,int revision,ApiSettings c,string text,CancellationToken token){try{var zh=await client.TranslateAsync(c,text,"zh",token);if(!closed&&!token.IsCancellationRequested&&reply==state&&revision==state.Revision)state.Translations[text]=zh;}
  catch(OperationCanceledException){}catch{if(reply==state&&revision==state.Revision){state.Failed.Add(text);Status("部分段落翻译失败，保留原文；点击“翻译／重试”。");}}
  finally{if(reply==state&&revision==state.Revision){state.Pending.Remove(text);if(!closed)Render();}}}
 private void Retry_Click(object s,RoutedEventArgs e){reply?.Failed.Clear();QueueReply(true);}
 private void PasteAnswer_Click(object s,RoutedEventArgs e){try{var text=Clipboard.GetText();if(text.Length is 0 or >60000)throw new InvalidOperationException("剪贴板文字为空或超过 60000 字。");followInterface=false;follower.Clear();replyCts.Cancel();replyCts.Dispose();replyCts=new();reply=new(){Id="paste"};reply.Update(text,true);SourceLabel.Text="手动粘贴回答，不跟随窗口或文件。";Render();QueueReply();}catch(Exception x){Status(Safe(x));}}
 private void Mode_Changed(object s,SelectionChangedEventArgs e){if(IsLoaded)Render();}
 private void Render(){if(reply==null)return;var mode=(ModeBox.SelectedItem as ComboBoxItem)?.Tag?.ToString()??"bilingual";var md=reply.Render(mode);FallbackReader.Text=md;ProgressLabel.Text=$"已译 {reply.Translations.Count} 段 · 处理中 {reply.Pending.Count}";
  if(!webReady||md==displayed)return;displayed=md;var html=MarkdownDisplay.ToHtml(md);
  Reader.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new{type="render",html}));}
 private void CopyReply_Click(object s,RoutedEventArgs e){try{if(reply?.Ready!=true)throw new InvalidOperationException("请等待回答和全部译文完成。");Clipboard.SetText(reply.Render("chinese"));Status("中文 Markdown 已复制。");}catch(Exception x){Status(Safe(x));}}
 private void ReaderMessage(object? s,CoreWebView2WebMessageReceivedEventArgs e){if(!e.Source.StartsWith("https://bridge.local/",StringComparison.Ordinal))return;try{var d=JsonNode.Parse(e.WebMessageAsJson);var type=d?["type"]?.ToString();if(type=="ready"){webReady=true;displayed="";Render();}
  else if(type=="copy"){var text=d?["text"]?.ToString()??"";if(text.Length<=200000){Clipboard.SetText(text);Status("已复制。");}}
  else if(type=="open"){var url=d?["url"]?.ToString();if(Uri.TryCreate(url,UriKind.Absolute,out var u)&&u.Scheme=="https")Process.Start(new ProcessStartInfo(u.AbsoluteUri){UseShellExecute=true});}
 }catch{Status("阅读区操作未完成，请重试。");}}
 private static string Safe(Exception x)=>x is OperationCanceledException?"操作已取消或接口超时，未自动重发。":x is InvalidOperationException?x.Message:x is HttpRequestException?"网络连接失败，请检查接口与网络。":"操作未完成，请检查当前窗口、控件或文件后重试。";
 private void Window_Closing(object? s,System.ComponentModel.CancelEventArgs e){closed=true;poll.Stop();promptCts.Cancel();replyCts.Cancel();Reader.Dispose();client.Dispose();}
}
