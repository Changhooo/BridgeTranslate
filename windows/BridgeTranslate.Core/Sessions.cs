using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
namespace BridgeTranslate.Core;
public sealed record AssistantRecord(string Id,string Session,string Text,bool Complete);
public static class SessionParser {
 public static AssistantRecord? Parse(string line){
  try{
   var d=JsonNode.Parse(line);if(d?["type"]?.ToString()!="assistant"||d["isSidechain"]?.ToString()=="true")return null;
   var msg=d["message"];if(msg?["role"]?.ToString() is string role&&role!="assistant")return null;
   var content=msg?["content"];var text=content is JsonArray a?string.Join("\n\n",a.Where(x=>x?["type"]?.ToString()=="text").Select(x=>x?["text"]?.ToString())):content is JsonValue?content.ToString():"";
   if(string.IsNullOrWhiteSpace(text)||text.Length>60000)return null;
   var id=msg?["id"]?.ToString()??d?["uuid"]?.ToString()??Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
   return new(id,d?["sessionId"]?.ToString()??"",text,msg?["stop_reason"]!=null);
  }catch{return null;}
 }
}
// Explicitly selected file only. Never searches or writes the user's Claude directories.
public sealed class SessionFollower {
 private string? path;private long offset;private readonly List<byte> pending=[];
 public string? Path=>path;
 public void Clear(){path=null;offset=0;pending.Clear();}
 public void Select(string value,bool readExisting){path=value;offset=readExisting?0:new FileInfo(value).Length;pending.Clear();}
 public async Task<List<AssistantRecord>> PollAsync(CancellationToken token){
  var result=new List<AssistantRecord>();if(path==null)return result;
  await using var fs=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete,8192,FileOptions.Asynchronous);
  if(fs.Length<offset){offset=0;pending.Clear();}if(fs.Length-offset>16*1024*1024){offset=Math.Max(0,fs.Length-16*1024*1024);pending.Clear();fs.Seek(offset,SeekOrigin.Begin);while(fs.ReadByte() is int b&&b>=0&&b!=10)offset++;offset=fs.Position;}
  fs.Seek(offset,SeekOrigin.Begin);var bytes=new byte[8192];int read;
  while((read=await fs.ReadAsync(bytes,token))>0){offset+=read;for(var i=0;i<read;i++){
   if(bytes[i]==10){if(pending.Count>0){var r=SessionParser.Parse(Encoding.UTF8.GetString(pending.ToArray()));if(r!=null)result.Add(r);pending.Clear();}}
   else{pending.Add(bytes[i]);if(pending.Count>2*1024*1024){pending.Clear();throw new InvalidOperationException("单行会话记录超过 2 MiB，已停止读取。");}}
  }}return result;
 }
}
public sealed class ReplyState {
 public string Id {get;init;}="";public string Source {get;private set;}="";public bool Complete {get;set;}
 public DateTime LastChange {get;private set;}=DateTime.UtcNow;
 public Dictionary<string,string> Translations {get;}=[];public HashSet<string> Pending {get;}=[];public HashSet<string> Failed {get;}=[];public int Revision {get;private set;}
 public bool Update(string text,bool complete){if(text==Source){Complete|=complete;return false;}if(!text.StartsWith(Source,StringComparison.Ordinal)){Revision++;Translations.Clear();Pending.Clear();Failed.Clear();}Source=text;Complete=complete;LastChange=DateTime.UtcNow;return true;}
 public IReadOnlyList<Segment> Parts=>MarkdownSegments.Split(Source,Complete);
 public bool Ready=>Complete&&Parts.Where(x=>!x.Keep&&x.Text.Any(char.IsLetter)&&!string.IsNullOrWhiteSpace(x.Text)).All(x=>Translations.ContainsKey(x.Text)||!x.Text.Any(c=>c<=127&&char.IsLetter(c)));
 public string Render(string mode)=>string.Concat(Parts.Select(p=>{
  if(p.Keep||mode=="original"||!Translations.TryGetValue(p.Text,out var zh))return p.Text;
  return mode=="chinese"?zh:p.Text.TrimEnd()+"\n\n"+zh.TrimEnd()+"\n\n";
 }));
}
