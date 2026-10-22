using System.Windows;
namespace BridgeTranslate.App;
public partial class App : Application {protected override void OnStartup(StartupEventArgs e){DispatcherUnhandledException+=(_,args)=>{MessageBox.Show("操作未完成，请检查配置或重新连接 CC。应用未自动重发问题。","桥译");args.Handled=true;};base.OnStartup(e);}}
