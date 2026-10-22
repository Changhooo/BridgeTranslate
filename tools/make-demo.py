"""Build a 45s screenshot-led promo. Python3 + Pillow + numpy + ffmpeg.
Screenshots supplied by the project owner. No API calls or live screen recording.
Set BRIDGE_CJK_FONT to a Chinese font; source screenshots live in docs/media/source.
"""
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont,ImageFilter
import argparse,subprocess,os,wave
import numpy as np
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'docs/media';B=ROOT/'.demo-build';B.mkdir(exist_ok=True)
p=argparse.ArgumentParser();p.add_argument('--poster-only',action='store_true');args=p.parse_args()
FONT=next((p for p in [Path(os.environ.get('BRIDGE_CJK_FONT','/nonexistent')),Path('/tmp/bridge-promo-font/NotoSansCJKsc-Regular.otf'),Path('C:/Windows/Fonts/msyh.ttc'),Path('/System/Library/Fonts/PingFang.ttc'),Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')] if p.is_file()),None)
if not FONT:raise SystemExit('Set BRIDGE_CJK_FONT to an installed Chinese font.')
W,H=1920,1080;BG='#f5f3ee';INK='#202b28';MUTED='#77817b';GREEN='#237663';PALE='#e6ede4';LINE='#dce0d7';fonts={}
def f(n):
 if n not in fonts:fonts[n]=ImageFont.truetype(str(FONT),n)
 return fonts[n]
def txt(im,x,y,s,n=28,c=INK):ImageDraw.Draw(im).text((x,y),s,font=f(n),fill=c)
def rr(im,xy,fill,r=20,outline=None,width=1):ImageDraw.Draw(im).rounded_rectangle(xy,r,fill=fill,outline=outline,width=width)
def pill(im,x,y,s,active=False,n=22):
 w=int(ImageDraw.Draw(im).textlength(s,font=f(n)))+38;rr(im,(x,y,x+w,y+48),GREEN if active else PALE,24);txt(im,x+19,y+7,s,n,'white' if active else GREEN);return w

def base(section=''):
 im=Image.new('RGB',(W,H),BG);txt(im,90,50,'桥译',32,GREEN);txt(im,176,60,'BRIDGE TRANSLATE',18,MUTED)
 if section:txt(im,1535,58,section,19,MUTED)
 ImageDraw.Draw(im).line((90,112,1830,112),fill=LINE,width=2);txt(im,90,1019,'中文提问  /  英文发送  /  双语阅读',19,MUTED);txt(im,1440,1019,'实际截图 · 操作动画示意',19,MUTED);return im

def screenshot(im,name,rect,crop=None):
 src=Image.open(OUT/'source'/name).convert('RGB')
 if crop:src=src.crop(crop)
 x,y,w,h=rect;scale=min(w/src.width,h/src.height);src=src.resize((int(src.width*scale),int(src.height*scale)),Image.Resampling.LANCZOS);sx=x+(w-src.width)//2;sy=y+(h-src.height)//2
 shadow=Image.new('RGBA',(W,H),(0,0,0,0));ImageDraw.Draw(shadow).rounded_rectangle((sx-8,sy-6,sx+src.width+8,sy+src.height+8),18,fill=(20,45,34,25));shadow=shadow.filter(ImageFilter.GaussianBlur(22));im.paste(shadow,(0,0),shadow);rr(im,(sx-1,sy-1,sx+src.width+1,sy+src.height+1),'white',12,LINE);im.paste(src,(sx,sy))

def intro():
 im=base('为 Claude 网页而做');pill(im,90,185,'桥译 · 正式版',True);txt(im,88,298,'中文提问。',104);txt(im,88,438,'英文发送。',104);txt(im,90,637,'阅读时，中文就在英文下面。',38,MUTED);rr(im,(1120,214,1810,827),'#e7ece3',38);txt(im,1176,276,'你好',64,GREEN);txt(im,1178,379,'Hello',72);ImageDraw.Draw(im).line((1178,526,1750,526),fill='#c8d6c8',width=2);txt(im,1178,572,'Hello! How can I help you today?',24);txt(im,1178,641,'你好！今天我能帮你什么？',31,GREEN);txt(im,90,875,'无需反复切换翻译软件',28,GREEN);return im

def input_scene(enter=False):
 im=base('01 / 回车译后发送');pill(im,90,196,'01  中文提问',True);txt(im,90,300,'写中文，',72);txt(im,90,402,'按下回车。',72);txt(im,94,562,'先翻译成英文',30,MUTED);txt(im,94,615,'再通过原发送按钮发出',30,MUTED);pill(im,90,742,'可选功能 · 默认关闭');screenshot(im,'compose.png',(680,248,1150,510),(0,8,921,225));rr(im,(790,755,1710,866),'#e8eee5',22)
 for x,s,c in [(824,'中文草稿',GREEN),(1006,'→',MUTED),(1060,'英文译文',GREEN),(1246,'→',MUTED),(1300,'发送',GREEN)]:txt(im,x,783,s,28,c)
 if enter:rr(im,(1514,650,1799,750),GREEN,20);txt(im,1550,671,'Enter',38,'white')
 txt(im,94,910,'开启「回车译后发送」即可；Shift + Enter 仍然换行。',25,MUTED);return im

def sent():
 im=base('01 / 英文提问，中文阅读');txt(im,90,165,'你发送英文，它回答后自动译成中文。',54);screenshot(im,'greeting.png',(190,325,1540,612));return im

def api_scene(step=2):
 im=base('02 / 使用自己的翻译 API');pill(im,90,185,'02  多家 API',True);txt(im,90,300,'模型，',80);txt(im,90,410,'由你选择。',80);txt(im,94,575,'URL + Key + 模型名称',29,MUTED);txt(im,94,638,'四种协议 · 支持兼容接口',27,MUTED);txt(im,94,828,'接口配置示意',22,MUTED);rr(im,(780,180,1830,875),'white',28,LINE)
 for i,(label,value) in enumerate([('API URL','https://api.example.com/v1'),('API Key','••••••••••••••••••••••••'),('模型名称','填写服务商提供的 model ID')]):
  y=225+i*159;txt(im,828,y,label,23,MUTED);rr(im,(828,y+50,1780,y+125),'#f8f9f5',13,'#88a997' if i==step else LINE,2);txt(im,852,y+65,value if i<=step else '等待填写…',29,INK if i<=step else '#aab0a8')
 pill(im,827,748,'授权并保存',True);pill(im,1050,748,'测试连接');x=90
 for s in ['OpenAI 兼容','Responses','Anthropic','Gemini','本机服务']:x+=pill(im,x,923,s,n=21)+14
 return im

def effect(detail=False):
 im=base('03 / 翻译效果')
 if detail:txt(im,90,156,'结构保留，中文就在原文下面。',52);screenshot(im,'bilingual.png',(135,282,1650,660),(0,0,1036,431))
 else:
  pill(im,90,185,'03  中英对照',True);txt(im,90,300,'读一段，',70);txt(im,90,402,'懂一段。',70);txt(im,94,572,'中文紧跟对应英文',29,MUTED);txt(im,94,626,'标题、列表、加粗照常保留',27,MUTED);pill(im,90,777,'仅翻译文字');screenshot(im,'bilingual.png',(650,194,1180,718))
 return im

def end():
 im=base('开始使用');pill(im,90,186,'桥译 · Bridge Translate',True);txt(im,90,321,'把精力留给问题本身。',86);txt(im,94,510,'回车译后发送   ·   自带 API   ·   逐段双语翻译',33,MUTED);rr(im,(90,683,1830,887),INK,26);txt(im,135,714,'源码与详细教程',24,'#aebfb1');txt(im,133,771,'github.com/Changhooo/BridgeTranslate',42,'white');return im
scenes=[('intro',4,intro()),('input',4,input_scene()),('enter',3,input_scene(True)),('sent',6,sent()),('api-url',2,api_scene(0)),('api-key',2,api_scene(1)),('api-model',5,api_scene(2)),('effect',7,effect()),('detail',7,effect(True)),('end',5,end())]
for name,_,im in scenes:im.save(B/(name+'.png'))
poster=base('中文提问 · 英文发送 · 双语阅读');txt(poster,90,158,'桥译，让对话少一次切换。',64);screenshot(poster,'greeting.png',(190,356,1540,612));poster.save(OUT/'demo-poster.png')
if args.poster_only:raise SystemExit()
clips=[]
for name,duration,_ in scenes:
 clip=B/(name+'.mp4');clips.append(clip);subprocess.run(['ffmpeg','-y','-loglevel','error','-loop','1','-framerate','30','-i',str(B/(name+'.png')),'-t',str(duration),'-vf',f'fade=t=in:st=0:d=0.18:color={BG},fade=t=out:st={duration-.15}:d=0.15:color={BG}','-an','-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-threads','2',str(clip)],check=True)
listing=B/'concat.txt';listing.write_text(''.join(f"file '{p.as_posix()}'\n" for p in clips));seconds=45;rate=44100;t=np.arange(seconds*rate)/rate;audio=np.zeros_like(t);chords=[(130.81,164.81,196),(110,130.81,164.81),(87.31,110,130.81),(98,123.47,146.83)]
for start in range(0,seconds,8):
 span=np.maximum(0,t-start);env=np.where(span<8,np.sin(np.pi*np.minimum(span,8)/8)**1.5,0)
 for hz in chords[(start//8)%4]:audio+=.017*np.sin(2*np.pi*hz*t)*env
 for j in range(4):
  q=t-(start+j*2);e=np.where((q>=0)&(q<1.5),np.exp(-np.maximum(q,0)*3)*np.minimum(np.maximum(q,0)/.02,1),0);audio+=.022*np.sin(2*np.pi*chords[(start//8)%4][j%3]*4*t)*e
q=t-8;audio+=.04*np.sin(2*np.pi*950*t)*np.where((q>=0)&(q<.1),np.exp(-np.maximum(q,0)*65),0);audio*=np.minimum(t,1)*np.minimum((seconds-t)/2,1)
with wave.open(str(B/'ambient.wav'),'w') as wav:wav.setnchannels(2);wav.setsampwidth(2);wav.setframerate(rate);wav.writeframes(np.repeat((np.clip(audio,-1,1)*32767).astype('<i2')[:,None],2,axis=1).tobytes())
subprocess.run(['ffmpeg','-y','-loglevel','error','-f','concat','-safe','0','-i',str(listing),'-i',str(B/'ambient.wav'),'-c:v','copy','-c:a','aac','-b:a','128k','-shortest','-movflags','+faststart',str(OUT/'bridge-translate-demo.mp4')],check=True);print('Promo: 45 seconds, 1080p30.')
