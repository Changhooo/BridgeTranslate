using System.Net;
using System.Text.RegularExpressions;
using Markdig;
namespace BridgeTranslate.Core;
public static class MarkdownDisplay {
 private static readonly MarkdownPipeline Pipeline=new MarkdownPipelineBuilder().UsePipeTables().UseTaskLists().UseAutoLinks().DisableHtml().Build();
 public static string ToHtml(string source){
  var values=new List<(string Key,string Tex,bool Display)>();var nonce=Guid.NewGuid().ToString("N");
  var masked=string.Concat(MarkdownSegments.Split(source,true).Select(segment=>{
   if(segment.Keep&&!segment.Text.TrimStart().StartsWith("$$")&&!segment.Text.TrimStart().StartsWith(@"\["))return segment.Text;
   return Regex.Replace(segment.Text,@"(`+)([^`\n]*?)\1|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\$(?!\s)([^$\n]+?)\$",m=>{
    if(m.Groups[1].Success)return m.Value;
    var display=m.Groups[4].Success||m.Groups[5].Success;var tex=m.Groups[3].Success?m.Groups[3].Value:m.Groups[4].Success?m.Groups[4].Value:m.Groups[5].Success?m.Groups[5].Value:m.Groups[6].Value;
    var key=$"BTMATH{nonce}N{values.Count}END";values.Add((key,tex,display));return key;
   });
  }));
  var html=Markdown.ToHtml(masked,Pipeline);
  foreach(var x in values)html=html.Replace(x.Key,$"<span class=\"math\" data-tex=\"{WebUtility.HtmlEncode(x.Tex)}\" data-display=\"{(x.Display?"true":"false")}\"></span>",StringComparison.Ordinal);
  return Regex.Replace(html,"(<img\\s[^>]*?)src=\"([^\"]*)\"","$1data-source=\"$2\"",RegexOptions.IgnoreCase);
 }
}
