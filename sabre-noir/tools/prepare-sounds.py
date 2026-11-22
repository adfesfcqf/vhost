import numpy as np,subprocess,os,glob,json
SR=44100;OUT='/tmp/claude-0/sn/out/snd';RAW='/tmp/claude-0/sn/raw';META='/tmp/claude-0/sn/Meta-open-sound/corpora/oculus-audio-pack/ogg'
def load(f,ch=1):
    raw=subprocess.run(['ffmpeg','-v','error','-i',f,'-ac',str(ch),'-ar',str(SR),'-f','f32le','-'],capture_output=True).stdout
    x=np.frombuffer(raw,dtype=np.float32).copy();return x.reshape(-1,ch) if ch>1 else x
def save(x,name,peak=0.89,br='96k'):
    ch=1 if x.ndim==1 else x.shape[1];m=np.abs(x).max() or 1;x=x/m*peak
    subprocess.run(['ffmpeg','-v','error','-y','-f','f32le','-ar',str(SR),'-ac',str(ch),'-i','-','-c:a','libmp3lame','-b:a',br,os.path.join(OUT,name+'.mp3')],input=x.astype(np.float32).tobytes())
def env(x):
    m=x if x.ndim==1 else np.abs(x).max(axis=1);w=int(.003*SR);return np.convolve(np.abs(m),np.ones(w)/w,'same')
def onsets(x,rel=.3,gap=.6):
    e=env(x);thr=e.max()*rel;idx=np.where(e>thr)[0];on=[];last=-10**9
    for k in idx:
        if k-last>int(gap*SR): on.append(k)
        last=k
    return on
def cut(x,s,dur,fade=.4):
    a=max(0,s-int(.003*SR));y=x[a:a+int(dur*SR)].copy();n=len(y);f=int(n*fade)
    g=np.linspace(1,0,f)**2;fi=np.linspace(0,1,40)
    if y.ndim==1: y[n-f:]*=g;y[:40]*=fi
    else: y[n-f:]*=g[:,None];y[:40]*=fi[:,None]
    return y
man={}
def shots(src,name,dur,n=3,gap=.6,ch=1,br='96k'):
    k=man.get(name,0)
    for s_ in src.split(','):
        x=load(f'{RAW}/{s_}.wav',ch)
        for s in onsets(x,.3,gap)[:n]:
            save(cut(x,s,dur),f'{name}{k}',.89,br);k+=1
    man[name]=k
def mech(src,name,dur=1.0,n=1,rel=.2):
    k=man.get(name,0);x=load(f'{RAW}/{src}.wav')
    for s in onsets(x,rel,.4)[:n]: save(cut(x,s,dur,.25),f'{name}{k}',.8,'80k');k+=1
    man[name]=k
FAM={ 'mosin':('M_20','M_21','M_24','M_23',.6), 'kar98':('E_20','E_22','E_18','E_19',.6), 'enfield':('B_17','B_23','B_15','B_21',.6),
 'garand':('U_13','U_12','U_17','U_16',.35), 'ppsh':('P_25','P_24','P_13','P_12',.15), 'm45':('G_26','G_25','G_14','G_13',.12),
 'lmg':('C_39','C_25','C_37','C_17',.12), 'pistol':('A_35','A_41','A_34','A_40',.4)}
for f,(fp,nr,md,fr,gap) in FAM.items():
    shots(fp,f+'_fp',1.9,3,gap,2,'128k');shots(nr,f+'_near',1.6,3,gap);shots(md,f+'_mid',2.0,3,gap);shots(fr,f+'_far',2.8,3,gap)
for f,src in [('mosin','M_2 M_4 M_6 M_7 M_1'),('kar98','E_3 E_5 E_7 E_8 E_0'),('enfield','E_3 B_3 B_5 B_6 B_0')]:
    u,b,fw,d,c=src.split();mech(u,f+'_boltup',.5);mech(b,f+'_boltback',.6);mech(fw,f+'_boltfwd',.6);mech(d,f+'_boltdown',.5);mech(c,f+'_clip',1.5)
mech('U_0','garand_clip',1.4);mech('U_3','garand_back',.7);mech('U_4','garand_release',.7)
for f,(o,i,b) in {'ppsh':('P_7','P_6','P_8'),'m45':('G_9','G_8','G_10'),'pistol':('A_3','A_4','A_16')}.items():
    mech(o,f+'_magout',.7);mech(i,f+'_magin',.7);mech(b,f+'_bolt',.7)
mech('C_11','lmg_magout',.8);mech('C_10','lmg_magin',.8);mech('C_12','lmg_bolt',.6);mech('C_13','lmg_release',.6);mech('P_1','dry',.4)
def meta(pat,name,maxn=6,dur=None,br='80k',peak=.8):
    fs=sorted(glob.glob(f'{META}/{pat}'))[:maxn];k=0
    for f in fs:
        x=load(f)
        if dur: x=x[:int(dur*SR)]
        save(x,f'{name}{k}',peak,br);k+=1
    man[name]=k
for a,b,c in [('FEETHmn_ShoeDirtWalk_*','step_dirt',5),('FEETHmn_ShoeDirtRun_*','run_dirt',5),('FEETHmn_ShoeWoodWalk_*','step_wood',5),('FEETHmn_ShoeWoodRun_*','run_wood',5),
 ('FEETHmn_ShoeConcreteWalk_*','step_stone',5),('FEETHmn_ShoeConcreteRun_*','run_stone',5),('FEETHmn_ShoeGrassWalk_*','step_grass',5),('FEETHmn_ShoeGrassRun_*','run_grass',5),
 ('FEETHmn_ShoeDirtLand_*','land',2),('BLLTShel_ShellCasingGrass_*','shell_grass',3),('BLLTShel_ShellCasingConcrete_*','shell_hard',3),('BLLTShel_ShellCasingMetal_*','shell_metal',3),
 ('CLOTHMvmt_MovementWithGear_*','gear',4),('CLOTHMvmt_ClothingMovement_*','cloth',4),('VOXMale_Male0*Hurt_*','hurt',6),('VOXMale_Male0*Death_*','death',6),('VOXEfrt_Male*','effort',2),
 ('METLImpt_MetalHitSurface_*','imp_metal',5),('FGHTImpt_PunchRegular_*','imp_flesh',6),('FGHTImpt_PunchHarder_*','imp_flesh_hard',4),('CERMImpt_*','imp_stone',1),('FGHTImpt_Kick_*','imp_dirt',5),
 ('WOODImpt_LargeWoodDrop_*','imp_wood',1),('METLImpt_MetalObjDrop_*','debris_metal',4),('GLASBrk_WindowPaneSmallBreak_*','glass',1),
 ('WHSH_WhooshSmall_*','whoosh',3),('MECHLvr_LeverPull_*','pin',3),('MECHSwtch_SwitchSmall*','switch',2),('OBJBag_ToolBagDrop_*','pickup',1),('HMNBrth_MaleBreathing_*','breath',1),
 ('ANMLDog_DogBark_*','dog',2),('MUSCStngr_VictoryOrchestral_*','win',1),('MUSCStngr_LossOrchestral_*','lose',1),('MUSCStngr_MarchingSnare_*','snare',1)]:
    meta(a,b,c)
for a,b in [('WINDVege_LightWindTreesBirds_*','amb_dawn'),('AMBFarm_FarmGeneric_*','amb_farm'),('AMBForst_Night_*','amb_night'),('WINDVege_WindTreesBirdsFlies_*','amb_wind2'),('CLOTHFlp_FlagFlapping_*','amb_flag'),('VEHCar_CarEngineSlow_*','engine')]:
    meta(a,b,1,45,'64k',.6)
json.dump(man,open(f'{OUT}/manifest.json','w'))
print(man,len(os.listdir(OUT)))
