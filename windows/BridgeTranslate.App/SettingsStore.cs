using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using BridgeTranslate.Core;
namespace BridgeTranslate.App;
public static class SettingsStore {
 public static string DirectoryPath=>System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"BridgeTranslate");
 public static ApiSettings Load(){var p=System.IO.Path.Combine(DirectoryPath,"settings.json");if(!File.Exists(p))return new();var c=JsonSerializer.Deserialize<ApiSettings>(File.ReadAllText(p))??new();if(c.ProtectedKey!=""){try{c.Key=Encoding.UTF8.GetString(Protect(Convert.FromBase64String(c.ProtectedKey),false));}catch{c.Key="";}}return c;}
 public static void Save(ApiSettings c){Directory.CreateDirectory(DirectoryPath);c.ProtectedKey=c.Key==""?"":Convert.ToBase64String(Protect(Encoding.UTF8.GetBytes(c.Key),true));var p=System.IO.Path.Combine(DirectoryPath,"settings.json");File.WriteAllText(p+".tmp",JsonSerializer.Serialize(c,new JsonSerializerOptions{WriteIndented=true}),new UTF8Encoding(false));File.Move(p+".tmp",p,true);}
 [StructLayout(LayoutKind.Sequential)]private struct Blob {public int Size;public nint Data;}
 private static byte[] Protect(byte[] bytes,bool encrypt){var input=new Blob{Size=bytes.Length,Data=Marshal.AllocHGlobal(bytes.Length)};Marshal.Copy(bytes,0,input.Data,bytes.Length);Blob output;
  try{var ok=encrypt?CryptProtectData(ref input,null,0,0,0,1,out output):CryptUnprotectData(ref input,0,0,0,0,1,out output);if(!ok)throw new InvalidOperationException("系统密钥保护操作失败。");try{var result=new byte[output.Size];Marshal.Copy(output.Data,result,0,result.Length);return result;}finally{LocalFree(output.Data);}}
  finally{Marshal.Copy(new byte[bytes.Length],0,input.Data,bytes.Length);Marshal.FreeHGlobal(input.Data);}
 }
 [DllImport("crypt32.dll",CharSet=CharSet.Unicode,SetLastError=true)]private static extern bool CryptProtectData(ref Blob input,string? description,nint entropy,nint reserved,nint prompt,uint flags,out Blob output);
 [DllImport("crypt32.dll",CharSet=CharSet.Unicode,SetLastError=true)]private static extern bool CryptUnprotectData(ref Blob input,nint description,nint entropy,nint reserved,nint prompt,uint flags,out Blob output);
 [DllImport("kernel32.dll")]private static extern nint LocalFree(nint p);
}
