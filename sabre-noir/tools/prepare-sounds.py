import numpy as np,subprocess,os,glob,json
SR=44100;OUT='/tmp/claude-0/sn/out/snd';RAW='/tmp/claude-0/sn/raw';META='/tmp/claude-0/sn/Meta-open-sound/corpora/oculus-audio-pack/ogg'
def load(f):
    raw=subprocess.run(['ffmpeg','-v','error','-i',f,'-ac','1','-ar',str(SR),'-f','f32le','-'],capture_output=True).stdout
    return np.frombuffer(raw,dtype=np.float32).copy()
def save(x,name,peak=0.89,br='96k'):
    m=np.abs(x).max() or 1; x=x/m*peak
    p=subprocess.run(['ffmpeg','-v','error','-y','-f','f32le','-ar',str(SR),'-ac','1','-i','-','-c:a','libmp3lame','-b:a',br,os.path.join(OUT,name+'.mp3')],input=x.astype(np.float32).tobytes())
    return len(x)/SR
def env(x):
    w=int(.003*SR);return np.convolve(np.abs(x),np.ones(w)/w,'same')
def onsets(x,rel=.3,gap=.6):
    e=env(x);thr=e.max()*rel;idx=np.where(e>thr)[0];on=[];last=-10**9
    for k in idx:
        if k-last>int(gap*SR): on.append(k)
        last=k
    return on
def cut(x,s,dur,fade=.35):
    a=max(0,s-int(.004*SR));y=x[a:a+int(dur*SR)].copy()
    n=len(y);f=int(n*fade);y[n-f:]*=np.linspace(1,0,f)**2;y[:40]*=np.linspace(0,1,40);return y
man={}
def shots(src,name,dur,n=3,gap=.6):
    x=load(f'{RAW}/{src}.wav');on=onsets(x,.3,gap)[:n];k=0
    for s in on:
        save(cut(x,s,dur),f'{name}{k}');k+=1
    man[name]=k
def mech(src,name,dur=1.0,n=1,rel=.2):
    x=load(f'{RAW}/{src}.wav');on=onsets(x,rel,.4)[:n];k=0
    for s in on: save(cut(x,s,dur,.25),f'{name}{k}',.8,'80k');k+=1
    man[name]=k
# player (behind shooter perspective) + near/mid/far for others
shots('M_20','rifle_fp',1.6);shots('M_21','rifle_near',1.4);shots('M_24','rifle_mid',1.8);shots('M_23','rifle_far',2.4)
shots('P_25','smg_fp',.9,4,.15);shots('P_24','smg_near',.9,4,.15);shots('P_13','smg_mid',1.2,3,.15);shots('P_12','smg_far',1.8,3,.15)
shots('A_35','pistol_fp',.9);shots('A_41','pistol_near',.9);shots('A_34','pistol_mid',1.2);shots('A_40','pistol_far',1.8)
shots('G_26','mg_fp',.9,3,.12);shots('G_25','mg_near',.9,3,.12);shots('G_14','mg_mid',1.2,3,.12);shots('G_13','mg_far',1.8,3,.12)
mech('M_2','bolt_up',.5);mech('M_4','bolt_back',.6);mech('M_6','bolt_fwd',.6);mech('M_7','bolt_down',.5);mech('M_1','rifle_clip',1.4)
mech('P_7','smg_magout',.7);mech('P_6','smg_magin',.7);mech('P_8','smg_bolt',.7);mech('P_1','dry',.4)
mech('A_3','pistol_magout',.6);mech('A_4','pistol_magin',.6);mech('A_16','pistol_slide',.6)
def meta(pat,name,maxn=6,dur=None,br='80k',peak=.8):
    fs=sorted(glob.glob(f'{META}/{pat}'))[:maxn];k=0
    for f in fs:
        x=load(f)
        if dur: x=x[:int(dur*SR)]
        save(x,f'{name}{k}',peak,br);k+=1
    man[name]=k
meta('FEETHmn_ShoeDirtWalk_*','step_dirt',5);meta('FEETHmn_ShoeDirtRun_*','run_dirt',5);meta('FEETHmn_ShoeWoodWalk_*','step_wood',5)
meta('FEETHmn_ShoeDirtLand_*','land',2);meta('BLLTShel_ShellCasingGrass_*','shell_grass',3);meta('BLLTShel_ShellCasingConcrete_*','shell_hard',3)
meta('CLOTHMvmt_MovementWithGear_*','gear',4);meta('VOXMale_Male0*Hurt_*','hurt',6);meta('VOXMale_Male0*Death_*','death',6)
meta('METLImpt_MetalHitSurface_*','hit_metal',5);meta('FGHTImpt_PunchRegular_*','hit_flesh',4);meta('HMNBrth_MaleBreathing_*','breath',1,None,'64k')
meta('OBJBag_ToolBagDrop_*','pickup',1);meta('WOODImpt_LargeWoodDrop_*','debris_wood',1);meta('METLImpt_MetalObjDrop_*','debris_metal',4)
meta('WINDVege_LightWindTreesBirds_*','amb_wind',1,40,'64k',.6);meta('AMBFarm_FarmGeneric_*','amb_farm',1,40,'64k',.6);meta('ANMLDog_DogBark_*','dog',2)
json.dump(man,open(f'{OUT}/manifest.json','w'))
print(man)
