/* ======================= ZANGE script.js (All-in-one) ======================= */
/* ------------ Storage helpers ------------ */
function getZanges(){ return JSON.parse(localStorage.getItem("zanges")||"[]"); }
function saveZanges(z){ localStorage.setItem("zanges", JSON.stringify(z||[])); }
function getParam(n){ const p=new URLSearchParams(location.search); return p.get(n); }

/* ------------ Profile helpers ------------ */
function getProfile(){
  // まずサーバーログインを参照（/api/me を使っている場合）
  const sessionEmail = getActiveProfileOwner();
  const key = _profileKeyFor(sessionEmail);
  const fallback = localStorage.getItem("profile"); // 旧データ互換
  const json = localStorage.getItem(key) || fallback;
  return json ? JSON.parse(json) : {};
}

function saveProfile(p){
  const sessionEmail = getActiveProfileOwner();
  const key = _profileKeyFor(sessionEmail);
  localStorage.setItem(key, JSON.stringify(p || {}));
  // 互換のため旧キーも更新（古い画面で参照していても破綻しないように）
  localStorage.setItem("profile", JSON.stringify(p || {}));
}

/* ------------ Auth / Users (localStorage) ------------ */
function getUsers(){ return JSON.parse(localStorage.getItem("users")||"[]"); }
function saveUsers(list){ localStorage.setItem("users", JSON.stringify(list||[])); }
function getAuthId(){ return localStorage.getItem("authUserId")||""; }
function setAuthId(id){ id?localStorage.setItem("authUserId",id):localStorage.removeItem("authUserId"); }
// 置き換え
function getAuthUser(){
  const id = getAuthId();
  const users = getUsers();
  let u = users.find(x => x.id === id) || null;
  if (u) return u;

  // ★サーバーログイン時のフォールバック
  return ensureLocalAuthFromActiveOwner();
}
function uid(){ return "u_"+Math.random().toString(36).slice(2,10); }

/* ------------ Public API (signup/login) ------------ */
function registerUser(email, pass, {nickname='匿名'}={}) {
  const users=getUsers();
  if(users.some(u=>u.email===email)){ alert("このメールは登録済みです"); return false; }
  const id=uid();
  const user={ id, email, pass,
    profile:{ nickname, avatar:"images/default-avatar.png", gender:"", age:"", bio:"" },
    following:[], followers:[]
  };
  users.push(user); saveUsers(users); setAuthId(id);
  localStorage.setItem("profile", JSON.stringify(user.profile));
  return true;
}
function loginUser(email, pass){
  const u=getUsers().find(x=>x.email===email && x.pass===pass);
  if(!u) return false;
  setAuthId(u.id);
  localStorage.setItem("profile", JSON.stringify(u.profile));
  return true;
}
function logoutUser(){ setAuthId(""); }

/* ------------ Follow ------------ */
function followUser(targetId){
  const me=getAuthUser(); if(!me){ alert("ログインが必要です"); return; }
  if(me.id===targetId) return;
  const users=getUsers(); const you=users.find(u=>u.id===targetId);
  if(!you){ alert("相手が見つかりません"); return; }
  if(!me.following.includes(targetId)) me.following.push(targetId);
  if(!you.followers.includes(me.id)) you.followers.push(me.id);
  saveUsers(users.map(u=>u.id===me.id?me:(u.id===you.id?you:u)));
}
function unfollowUser(targetId){
  const me=getAuthUser(); if(!me){ alert("ログインが必要です"); return; }
  const users=getUsers(); const you=users.find(u=>u.id===targetId); if(!you) return;
  me.following=me.following.filter(id=>id!==targetId);
  you.followers=you.followers.filter(id=>id!==me.id);
  saveUsers(users.map(u=>u.id===me.id?me:(u.id===you.id?you:u)));
}

/* ------------ Misc helpers ------------ */
function formatYMD(ts){ const d=new Date(ts); return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`; }
function isMyPost(z){
  const me=getAuthUser();
  if(me && z.ownerId && String(z.ownerId)===String(me.id)) return true;
  return z.owner==="me"; // 旧データ互換
}
// 置き換え版：index のカードに「フォロー/フォロー中」ボタンを常に試みて表示
function buildOwnerInfoByZange(z){
  let avatar = "images/default-avatar.png", nickname = "匿名";
  let resolvedOwnerId = z.ownerId || null;

  // 既存の所有者情報を復元
  if (z.ownerId) {
    const u = getUsers().find(u => u.id === z.ownerId);
    if (u) {
      avatar   = u.profile?.avatar   || avatar;
      nickname = u.profile?.nickname || nickname;
    }
  } else if (z.ownerProfile) {
    avatar   = z.ownerProfile.avatar   || avatar;
    nickname = z.ownerProfile.nickname || nickname;
  }

  // ownerId が無い古い投稿でも、ニックネームが一意ならユーザーを推定
  if (!resolvedOwnerId && nickname && nickname !== "匿名") {
    const candidates = getUsers().filter(u => (u.profile?.nickname || "") === nickname);
    if (candidates.length === 1) {
      resolvedOwnerId = candidates[0].id;
      // 投稿データには書き戻さない（既存仕様維持＆安全のため）
    }
  }

  // 表示ノード
  const wrap = document.createElement("div");
  Object.assign(wrap.style, { display:"flex", alignItems:"center", gap:"10px", marginBottom:"6px" });

  const img = document.createElement("img");
  Object.assign(img, { src: avatar, alt: "avatar" });
  Object.assign(img.style, { width:"40px", height:"40px", borderRadius:"50%", objectFit:"cover" });
  wrap.appendChild(img);

  const name = document.createElement("span");
  name.textContent = nickname;
  Object.assign(name.style, { fontWeight:"600", fontSize:"15px" });
  wrap.appendChild(name);

  // フォローボタン（自分以外 & 所有者が特定できた時だけ）
  const me = getAuthUser();
  if (resolvedOwnerId && me && me.id !== resolvedOwnerId) {
    const isFollowing = (me.following || []).includes(resolvedOwnerId);
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.dataset.followUser = resolvedOwnerId;
    btn.style.marginLeft = "auto";
    btn.textContent = isFollowing ? "フォロー中" : "フォローする";

    btn.addEventListener("click", () => {
      const nowMe = getAuthUser();
      if (!nowMe) { alert("ログインが必要です"); return; }
      ((nowMe.following || []).includes(resolvedOwnerId))
        ? unfollowUser(resolvedOwnerId)
        : followUser(resolvedOwnerId);

      const latest = (getAuthUser()?.following || []).includes(resolvedOwnerId);
      // 同一ユーザーの全ボタンを更新
      document.querySelectorAll(`button[data-follow-user="${resolvedOwnerId}"]`)
        .forEach(b => { b.textContent = latest ? "フォロー中" : "フォローする"; b.disabled = false; });

      // 既存仕様のままフォロー欄も更新
      if (typeof renderFollowBoxesSafe === "function") renderFollowBoxesSafe();
    });

    wrap.appendChild(btn);
  }

  return wrap;
}
/* ------------ Seed sample ------------ */
;(function seedIfEmpty(){
  const z=getZanges();
  if(z.length===0){
    const now=new Date();
    saveZanges([{
      id: now.getTime()-10000,
      text:"会議中にSlackばっか見てました📱",
      targets:["上司"], futureTag:"#集中します", scope:"public",
      timestamp:new Date(now.getTime()-10000).toISOString(),
      reactions:{pray:0,laugh:1,sympathy:1,growth:1}, comments:[],
      ownerProfile:{ nickname:"匿名", avatar:"images/default-avatar.png" }
    }]);
  }
})();

/* ------------ Post (post.html) ------------ */
const postForm=document.getElementById("postForm");
if(postForm){
  postForm.addEventListener("submit",e=>{
    e.preventDefault();
    const text=(document.getElementById("zangeText")?.value||"").trim();
    const fixed=(document.getElementById("zangeTargetFixed")?.value||"").trim();
    const futureTag=(document.getElementById("futureTag")?.value||"").trim();
    const scope=document.querySelector('input[name="scope"]:checked')?.value||"public";
    const bg=(document.getElementById("zangeBg")?.value||"").trim();
    if(!text) return alert("内容入力してください。");
    if(!fixed) return alert("対象を選んでください。");

    // --- ★ 325文字制限追加 ---
    if (text.length === 0) {
      return alert("内容入力してください。");
    }
    if (text.length > 325) {
      return alert("325文字以内で入力してください。");
    }
    if (!fixed) {
      return alert("対象を選んでください。");
    }
    // ------------------------
    
    const prof=getProfile()||{}; const authUser=getAuthUser();
    const newZange={
      id: Date.now(),
      text, targets:[fixed], futureTag, scope,
      timestamp:new Date().toISOString(),
      reactions:{pray:0,laugh:0,sympathy:0,growth:0}, comments:[],
      bg,
      ownerId: authUser?authUser.id:null,
      ownerProfile:{
        nickname: prof.nickname||(authUser?.profile?.nickname)||"匿名",
        avatar:   prof.avatar  ||(authUser?.profile?.avatar)  ||"images/default-avatar.png"
      }
    };
    const list=getZanges(); list.unshift(newZange); saveZanges(list);
    alert("投稿しました！"); location.href="index.html";
  });
}

/* ================== Reactions: built-in & custom stamps ================== */
/* ---- 配置ディレクトリ & カタログ（basename に拡張子は付けない） ---- */
const STAMP_BASE_DIRS = (
  window.STAMP_BASE_DIRS || [
    'images/stamps',
    'stamps',
    'assets/images/stamps',
    'assets/stamps',
    'img/stamps',
    './images/stamps',
    './stamps',
    '/images/stamps'
  ]
);

// 画像は <dir>/<basename>.(png|webp|jpg|jpeg) を順に探索
const STAMP_CATALOG = [
  { key:'zange',  label:'ZANGE', basename:'ZANGE' },
  { key:'erai',     label:'えらい',       basename:'erai' },
  { key:'Oh',  label:'Oh',   basename:'Oh' },
  { key:'nanyate',   label:'なんやて',   basename:'nanyate' },
  { key:'wakaru', label:'わかる',   basename:'wakaru' },
  { key:'wwww', label:'wwww',   basename:'wwww' },
  { key:'YES', label:'YES',   basename:'YES' },
  { key:'e', label:'え？',   basename:'e' },
  { key:'ho', label:'ほぅ',   basename:'ho' },
  { key:'yaba', label:'やば',   basename:'yaba' },
  { key:'otsu', label:'おつかれ',   basename:'otsu' },
  { key:'kini', label:'きになる',   basename:'kini' },
  { key:'n', label:'ん？',   basename:'n' },
  { key:'onaji', label:'同じく',   basename:'onaji' },
  { key:'no', label:'NO',   basename:'NO' },
];
const BUILTIN_REACTIONS=['pray','laugh','sympathy','growth'];

/* ---- Safe image loader ---- */
function loadImgWithFallback(imgEl, candidates, onSuccess, onFail){
  let i=0;
  function next(){
    if(i>=candidates.length){ imgEl.style.display='none'; onFail&&onFail(); return; }
    const url=candidates[i++]; imgEl.onload=()=>{ imgEl.style.display='inline-block'; onSuccess&&onSuccess(url); };
    imgEl.onerror=next; imgEl.src=url;
  }
  next();
}

/* ---- 候補 URL 生成（固定文字列は廃止） ---- */
function buildStampCandidates(basename){
  const exts = ['png','webp','jpg','jpeg'];
  const urls = [];
  STAMP_BASE_DIRS.forEach(dir=>{
    const base = dir.replace(/\/$/,'');
    exts.forEach(ext=> urls.push(`${base}/${basename}.${ext}`));
  });
  return urls;
}

/* ---- Skin built-in reaction buttons to image + count ---- */
function skinReactionButtons(root = document){
  const MAP = {
    pray:     { src:'images/reactions/pray.png',     emoji:'🙏' },
    laugh:    { src:'images/reactions/laugh.png',    emoji:'😂' },
    sympathy: { src:'images/reactions/sympathy.png', emoji:'🤝' },
    growth:   { src:'images/reactions/growth.png',   emoji:'🌱' },
  };
  root.querySelectorAll('.reactions button').forEach(btn=>{
    if(btn.classList.contains('rx-btn')) return;
    const m=btn.getAttribute('onclick')?.match(/'(\w+)'/); if(!m) return;
    const type=m[1]; if(!MAP[type]) return;

    const current = btn.querySelector('.rx-count')
      ? btn.querySelector('.rx-count').textContent
      : (btn.textContent.trim().split(/\s+/)[1] || '0');

    btn.classList.add('rx-btn',`rx-${type}`);
    btn.innerHTML = `
      <img class="rx-ic" alt="" style="width:22px;height:22px;vertical-align:middle;display:none;">
      <span class="rx-fallback" aria-hidden="false" style="font-size:18px;line-height:1;">${MAP[type].emoji}</span>
      <span class="rx-count" style="margin-left:6px;">${current}</span>
    `;
    const img=btn.querySelector('.rx-ic'); const fb=btn.querySelector('.rx-fallback');
    if(img){
      img.onload=()=>{ img.style.display='inline-block'; fb.style.display='none'; };
      img.onerror=()=>{ img.style.display='none'; fb.style.display='inline'; };
      img.src=MAP[type].src;
    }
  });
}

/* ---- Ensure "+" button ---- */
function ensurePlusButton(host, postId){
  if(host.querySelector(`button.rx-add[data-post="${postId}"]`)) return;
  const plus=document.createElement('button');
  plus.className='rx-add'; plus.dataset.post=String(postId); plus.type='button';
  plus.textContent='＋'; plus.setAttribute('aria-label','スタンプを追加');
  plus.onclick=()=>openStampPicker(postId);
  host.appendChild(plus);
}

/* ---- Ensure a custom-stamp button exists in host ---- */
function ensureCustomStampButtonInHost(host, postId, key, count){
  if (host.querySelector(`button[onclick="reactStamp(${postId}, '${key}')"]`)) return;
  const info = STAMP_CATALOG.find(x => x.key === key); if (!info) return;

  const btn=document.createElement('button');
  btn.className='rx-btn'; btn.type='button';
  btn.setAttribute('onclick',`reactStamp(${postId}, '${key}')`);
  btn.innerHTML=`
    <img class="rx-ic" alt="${info.label}" style="width:22px;height:22px;vertical-align:middle;display:none;">
    <span class="rx-text" style="font-size:12px;padding:2px 6px;border-radius:10px;background:#f1f5f9;display:inline;">${info.label}</span>
    <span class="rx-count" style="margin-left:6px;">${count||0}</span>
  `;
  const img=btn.querySelector('.rx-ic'); const text=btn.querySelector('.rx-text');
  if(img){
    const cands=buildStampCandidates(info.basename);
    loadImgWithFallback(img,cands,()=>{ text.style.display='none'; },()=>{ text.style.display='inline'; });
  }
  const plus=host.querySelector(`button.rx-add[data-post="${postId}"]`);
  if(plus) host.insertBefore(btn,plus); else host.appendChild(btn);
}

/* ---- After a card's reactions HTML inserted ---- */
function finishReactionsRender(hostOrCard, zange){
  const host=hostOrCard?.classList?.contains('reactions') ? hostOrCard : hostOrCard?.querySelector?.('.reactions');
  if(!host) return;
  skinReactionButtons(host);
  if(!zange) return;
  ensurePlusButton(host, zange.id);
  Object.entries(zange.reactions||{})
    .filter(([k])=>!BUILTIN_REACTIONS.includes(k))
    .forEach(([k,v])=> ensureCustomStampButtonInHost(host, zange.id, k, v||0));
}

/* ---- Update count helper ---- */
function updateStampCountDisplay(postId,key,count){
  document.querySelectorAll(`button[onclick="reactStamp(${postId}, '${key}')"] .rx-count`)
    .forEach(span=>span.textContent=count);
}

/* ---- Lookup all hosts for this post and add button if missing ---- */
function addButtonToAllHosts(postId,key,count){
  const anchors=document.querySelectorAll(`button[onclick^="react(${postId},"]`);
  const hosts=new Set(); anchors.forEach(a=>{ const h=a.closest('.reactions'); if(h) hosts.add(h); });
  hosts.forEach(h=>{ ensurePlusButton(h,postId); ensureCustomStampButtonInHost(h,postId,key,count); });
}

/* ---- Built-in reaction click ---- */
function react(id,type){
  const zanges=getZanges(); const z=zanges.find(x=>x.id===id); if(!z) return;
  z.reactions[type]=(z.reactions[type]||0)+1; saveZanges(zanges);

  document.querySelectorAll(`button[onclick="react(${id}, '${type}')"]`).forEach(btn=>{
    const span=btn.querySelector('.rx-count');
    if(span){ span.textContent=z.reactions[type]; }
    else{ btn.textContent=`${btn.textContent.split(" ")[0]} ${z.reactions[type]}`; }
  });

  const me=getAuthUser();
  if(z.ownerId && me && me.id!==z.ownerId){
    const label={pray:"🙏",laugh:"😂",sympathy:"🤝",growth:"🌱"}[type];
    const actor=me.profile?.nickname||me.email||"ユーザー";
    addNotificationFor(z.ownerId,{type:"reaction",text:`${actor} さんがあなたの投稿に ${label}`,postId:z.id,url:`detail.html?id=${z.id}`});
    updateNotifBadge();
  }
}

/* ---- Custom-stamp click ---- */
function reactStamp(id,key){
  const zanges=getZanges(); const z=zanges.find(x=>String(x.id)===String(id)); if(!z) return;
  if(!z.reactions) z.reactions={pray:0,laugh:0,sympathy:0,growth:0};
  if(typeof z.reactions[key]!=='number') z.reactions[key]=0;
  z.reactions[key]+=1; saveZanges(zanges);

  addButtonToAllHosts(id,key,z.reactions[key]);
  updateStampCountDisplay(id,key,z.reactions[key]);

  const me=getAuthUser();
  if(z.ownerId && me && me.id!==z.ownerId){
    const info=STAMP_CATALOG.find(s=>s.key===key);
    const actor=me.profile?.nickname||me.email||"ユーザー";
    addNotificationFor(z.ownerId,{type:"reaction",text:`${actor} さんがあなたの投稿にスタンプ（${info?.label||key}）`,postId:z.id,url:`detail.html?id=${z.id}`});
    updateNotifBadge();
  }
}

/* ---- Stamp picker modal (auto-injected) ---- */
let _stampModalBuilt=false, _stampPickTargetId=null;
function buildStampModalOnce(){
  if (_stampModalBuilt) return;
  const grid=document.getElementById('stampGrid'); if(!grid) return;
  grid.innerHTML='';
  STAMP_CATALOG.forEach(st=>{
    const cell=document.createElement('div');
    cell.className='stamp-item'; cell.dataset.key=st.key; cell.title=st.label;
    Object.assign(cell.style,{display:'flex',justifyContent:'center',alignItems:'center',borderRadius:'10px',background:'#f8fafc',padding:'6px'});

    const img=document.createElement('img'); img.alt=st.label; img.style.width='48px'; img.style.height='48px'; img.style.display='none';
    const txt=document.createElement('span'); txt.textContent=st.label; txt.style.fontSize='12px'; txt.style.fontWeight='700';

    const cands=buildStampCandidates(st.basename);
    loadImgWithFallback(img,cands,()=>{ txt.style.display='none'; },()=>{ txt.style.display='inline'; });

    cell.appendChild(img); cell.appendChild(txt); grid.appendChild(cell);
  });
  _stampModalBuilt=true;
}
function openStampPicker(postId){ _stampPickTargetId=postId; buildStampModalOnce(); const b=document.getElementById('stampModalBackdrop'); if(!b) return; b.style.display='block'; b.setAttribute('aria-hidden','false'); }
function closeStampPicker(){ const b=document.getElementById('stampModalBackdrop'); if(!b) return; b.style.display='none'; b.setAttribute('aria-hidden','true'); _stampPickTargetId=null; }
document.addEventListener('click', e=>{
  const cell=e.target.closest('.stamp-item'); if(!cell) return;
  const back=document.getElementById('stampModalBackdrop'); if(!back || back.style.display!=='block') return;
  const key=cell.dataset.key; if(_stampPickTargetId!=null){ reactStamp(_stampPickTargetId,key); closeStampPicker(); }
});

/* ================== Timeline (index.html) ================== */
const timeline=document.getElementById("timeline");
if(timeline){
  const list=getZanges().filter(z=>z.scope==="public");
  timeline.innerHTML="";
  list.forEach(z=>{
    const card=document.createElement("div"); card.className="card";
    const owner=buildOwnerInfoByZange(z); if(owner) card.appendChild(owner);

    if(typeof z.bg==="string" && z.bg.trim()!==""){
      const vis=document.createElement("div"); vis.className="zange-visual";
      const img=document.createElement("img"); img.src="images/"+z.bg; img.alt="背景画像";
      vis.appendChild(img); card.appendChild(vis);
    }

    const cap=document.createElement("div"); cap.className="zange-caption"; cap.textContent=z.text; card.appendChild(cap);
    const date=document.createElement("small"); date.textContent=formatYMD(z.timestamp); card.appendChild(date);

    const lineTargets=document.createElement("small");
    lineTargets.appendChild(document.createTextNode("🙏："));
    const tItems=Array.isArray(z.targets)&&z.targets.length?z.targets:(((z.target||"").replace(/への懺悔$/u,"").trim())?[(z.target||"").replace(/への懺悔$/u,"").trim()]:[]);
    if(tItems.length===0) lineTargets.appendChild(document.createTextNode("—"));
    else tItems.forEach(t=>{ const a=document.createElement("a"); a.href=`search.html?q=${encodeURIComponent(t)}`; a.textContent=t;
      Object.assign(a.style,{textDecoration:"none",padding:"2px 6px",marginRight:"6px",borderRadius:"999px",background:"#f1f5f9",display:"inline-block",fontSize:"12px"});
      lineTargets.appendChild(a);
    });
    card.appendChild(lineTargets);

    const lineTags=document.createElement("small");
    lineTags.appendChild(document.createTextNode("🏷️："));
    const tagItems=((z.futureTag||"").trim()
      ? (z.futureTag||"").replace(/[＃#]/g,"").split(/[,\uff0c、\s]+/u).map(s=>s.trim()).filter(Boolean)
      : []);
    if(tagItems.length===0) lineTags.appendChild(document.createTextNode("—"));
    else tagItems.forEach(tag=>{ const a=document.createElement("a"); a.href=`search.html?q=${encodeURIComponent(tag)}`; a.textContent=tag;
      Object.assign(a.style,{textDecoration:"none",padding:"2px 6px",marginRight:"6px",borderRadius:"999px",background:"#f1f5f9",display:"inline-block",fontSize:"12px"});
      lineTags.appendChild(a);
    });
    card.appendChild(lineTags);

    const reactions=document.createElement("div");
    reactions.className="reactions";
    reactions.innerHTML=`
      <button type="button" onclick="react(${z.id}, 'pray')">🙏 ${z.reactions.pray}</button>
      <button type="button" onclick="react(${z.id}, 'laugh')">😂 ${z.reactions.laugh}</button>
      <button type="button" onclick="react(${z.id}, 'sympathy')">🤝 ${z.reactions.sympathy}</button>
      <button type="button" onclick="react(${z.id}, 'growth')">🌱 ${z.reactions.growth}</button>
    `;
    card.appendChild(reactions);
    finishReactionsRender(card, z);

    const commentsCount=Array.isArray(z.comments)?z.comments.length:0;
    const commentLink=document.createElement("a");
    commentLink.href=`detail.html?id=${z.id}`;
    commentLink.textContent=`💬 コメント（${commentsCount}）`;
    Object.assign(commentLink.style,{display:"inline-block",marginTop:"8px",textDecoration:"none"});
    card.appendChild(commentLink);

    if(commentsCount>0){
      const pv=document.createElement("div"); pv.className="comments-preview"; pv.style.marginTop="6px";
      z.comments.slice(-2).forEach(c=>{
        const row=document.createElement("div"); row.className="c-row";
        Object.assign(row.style,{fontSize:"13px",color:"#667085",marginTop:"4px"});
        row.textContent=`・${(c.user||"匿名").trim()}: ${(c.text||"").trim()}`;
        pv.appendChild(row);
      });
      card.appendChild(pv);
    }

    timeline.appendChild(card);
  });
}

/* ================== Detail page ================== */
;(function initDetailPage(){
  const host=document.getElementById('detailCard')||document.getElementById('detailContainer'); if(!host) return;
  const id=getParam('id'); if(!id){ host.innerHTML='<p class="muted">投稿が見つかりませんでした。</p>'; return; }
  const zanges=getZanges(); const z=zanges.find(x=>String(x.id)===String(id));
  if(!z){ host.innerHTML='<p class="muted">投稿が見つかりませんでした。</p>'; return; }
  if(z.scope!=='public' && !isMyPost(z)){ host.innerHTML='<p class="muted">この懺悔は非公開です。</p>'; return; }

  host.innerHTML=''; const card=document.createElement('div'); card.className='card';
  const head=buildOwnerInfoByZange(z); if(head) card.appendChild(head);
  if(typeof z.bg==='string' && z.bg.trim()!==''){ const vis=document.createElement('div'); vis.className='zange-visual';
    const img=document.createElement('img'); img.src='images/'+z.bg; img.alt='背景画像'; vis.appendChild(img); card.appendChild(vis); }
  const cap=document.createElement('div'); cap.className='zange-caption'; cap.textContent=z.text; card.appendChild(cap);
  const date=document.createElement('small'); date.textContent=`${formatYMD(z.timestamp)}`; card.appendChild(date);

  const lineTargets=document.createElement('small'); lineTargets.appendChild(document.createTextNode('🙏：'));
  const tItems=Array.isArray(z.targets)&&z.targets.length?z.targets:(((z.target||'').replace(/への懺悔$/u,'').trim())?[(z.target||'').replace(/への懺悔$/u,'').trim()]:[]);
  if(tItems.length===0) lineTargets.appendChild(document.createTextNode('—'));
  else tItems.forEach(t=>{ const a=document.createElement('a'); a.href=`search.html?q=${encodeURIComponent(t)}`; a.textContent=t;
    Object.assign(a.style,{textDecoration:'none',padding:'2px 6px',marginRight:'6px',borderRadius:'999px',background:'#f1f5f9',display:'inline-block',fontSize:'12px'});
    lineTargets.appendChild(a); });
  card.appendChild(lineTargets);

  const lineTags=document.createElement('small'); lineTags.appendChild(document.createTextNode('🏷️：'));
  const tagItems=((z.futureTag||'').trim()? (z.futureTag||'').replace(/[＃#]/g,'').split(/[,\uff0c、\s]+/u).map(s=>s.trim()).filter(Boolean):[]);
  if(tagItems.length===0) lineTags.appendChild(document.createTextNode('—'));
  else tagItems.forEach(tag=>{ const a=document.createElement('a'); a.href=`search.html?q=${encodeURIComponent(tag)}`; a.textContent=tag;
    Object.assign(a.style,{textDecoration:'none',padding:'2px 6px',marginRight:'6px',borderRadius:'999px',background:'#f1f5f9',display:'inline-block',fontSize:'12px'});
    lineTags.appendChild(a); });
  card.appendChild(lineTags);

  const reactions=document.createElement('div'); reactions.className='reactions';
  reactions.innerHTML=`
    <button type="button" onclick="react(${z.id}, 'pray')">🙏 ${z.reactions.pray}</button>
    <button type="button" onclick="react(${z.id}, 'laugh')">😂 ${z.reactions.laugh}</button>
    <button type="button" onclick="react(${z.id}, 'sympathy')">🤝 ${z.reactions.sympathy}</button>
    <button type="button" onclick="react(${z.id}, 'growth')">🌱 ${z.reactions.growth}</button>
  `;
  card.appendChild(reactions);
  finishReactionsRender(card, z);

  host.appendChild(card);

  // comments
  function renderComments(zange){
    const wrap=document.getElementById('commentList'); if(!wrap) return;
    const comments=Array.isArray(zange.comments)?zange.comments:(zange.comments=[]);
    wrap.innerHTML='';
    if(comments.length===0){ wrap.innerHTML='<p class="muted">まだコメントはありません。</p>'; return; }
    comments.forEach(c=>{
      const item=document.createElement('div'); item.className='comment';
      const meta=document.createElement('small'); meta.textContent=`${(c.user||'匿名')}・${new Date(c.ts||Date.now()).toLocaleString()}`;
      const body=document.createElement('div'); body.textContent=c.text||'';
      item.appendChild(meta); item.appendChild(body); wrap.appendChild(item);
    });
  }
  renderComments(z);

  const form=document.getElementById('commentForm')||document.querySelector('.comment-form');
  if(form){
    form.addEventListener('submit',e=>{
      e.preventDefault();
      const nameInput=document.getElementById('commentUser')||document.getElementById('cName');
      const textInput=document.getElementById('commentText')||document.getElementById('cText');
      const name=(nameInput?.value||getProfile().nickname||'匿名').trim();
      const text=(textInput?.value||'').trim(); if(!text){ alert('コメントを入力してください。'); return; }
      // ★ここに文字数チェックを追加
      if(text.length > 33){
        alert('コメントは32.5文字以内で入力してください。');
        return;
      }
      const all=getZanges(); const target=all.find(x=>String(x.id)===String(id)); if(!target){ alert('投稿が見つかりません。'); return; }
      if(!Array.isArray(target.comments)) target.comments=[];
      target.comments.push({user:name||'匿名', text, ts:new Date().toISOString()}); saveZanges(all);
      if(nameInput) nameInput.value=''; if(textInput) textInput.value=''; renderComments(target);

      const me=getAuthUser();
      if(target.ownerId && me && me.id!==target.ownerId){
        const actor=me.profile?.nickname||me.email||name||'ユーザー';
        addNotificationFor(target.ownerId,{type:'comment',text:`${actor} さんがあなたの投稿にコメントしました`,postId:target.id,url:`detail.html?id=${target.id}`});
        updateNotifBadge();
      }
    });
  }
})();

/* ================== Search (search.html) ================== */
;(function initSearchUI(){
  const box=document.getElementById('searchBox')||
              document.querySelector('[data-role="searchBox"]')||
              document.querySelector('#headerSearch')||
              document.querySelector('input[type="search"]');
  const goSearch=()=>{ if(!box) return; const q=(box.value||'').trim(); location.href=q?`search.html?q=${encodeURIComponent(q)}`:'search.html'; };
  if(box){ box.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); goSearch(); } }); document.getElementById('searchButton')?.addEventListener('click',goSearch); }

  const results=document.getElementById('searchResults'); if(!results) return;
  const q=(new URLSearchParams(location.search)).get('q')||''; if(box) box.value=q;
  const keyword=q.trim().toLowerCase();

  const list=getZanges()
    .filter(z=>z.scope==='public')
    .filter(z=>{
      if(!keyword) return true;
      const text=(z.text||'').toLowerCase();
      const target=(Array.isArray(z.targets)&&z.targets.length ? z.targets.join('、') : ((z.target||'').replace(/への懺悔$/u,''))).toLowerCase();
      const tags=(z.futureTag||'').replace(/[＃#]/g,'').toLowerCase();
      return text.includes(keyword)||target.includes(keyword)||tags.includes(keyword);
    })
    .sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));

  results.innerHTML='';
  if(list.length===0){ results.innerHTML='<p class="muted">該当する投稿はありません。</p>'; return; }

  list.forEach(z=>{
    const card=document.createElement('div'); card.className='card';
    const owner=buildOwnerInfoByZange(z); if(owner) card.appendChild(owner);

    if(typeof z.bg==='string' && z.bg.trim()!==''){ const vis=document.createElement('div'); vis.className='zange-visual';
      const img=document.createElement('img'); img.src='images/'+z.bg; img.alt='背景画像';
      vis.appendChild(img); card.appendChild(vis); }

    const cap=document.createElement('div'); cap.className='zange-caption'; cap.textContent=z.text; card.appendChild(cap);
    const date=document.createElement('small'); date.textContent=`${formatYMD(z.timestamp)}`; card.appendChild(date);

    const lineTargets=document.createElement('small'); lineTargets.appendChild(document.createTextNode('🙏：'));
    const tItems=Array.isArray(z.targets)&&z.targets.length?z.targets:(((z.target||'').replace(/への懺悔$/u,'').trim())?[(z.target||'').replace(/への懺悔$/u,'').trim()]:[]);
    if(tItems.length===0) lineTargets.appendChild(document.createTextNode('—'));
    else tItems.forEach(t=>{ const a=document.createElement('a'); a.href=`search.html?q=${encodeURIComponent(t)}`; a.textContent=t;
      Object.assign(a.style,{textDecoration:'none',padding:'2px 6px',marginRight:'6px',borderRadius:'999px',background:'#f1f5f9',display:'inline-block',fontSize:'12px'});
      lineTargets.appendChild(a); });
    card.appendChild(lineTargets);

    const lineTags=document.createElement('small'); lineTags.appendChild(document.createTextNode('🏷️：'));
    const tagItems=((z.futureTag||'').trim()? (z.futureTag||'').replace(/[＃#]/g,'').split(/[,\uff0c、\s]+/u).map(s=>s.trim()).filter(Boolean):[]);
    if(tagItems.length===0) lineTags.appendChild(document.createTextNode('—'));
    else tagItems.forEach(tag=>{ const a=document.createElement('a'); a.href=`search.html?q=${encodeURIComponent(tag)}`; a.textContent=tag;
      Object.assign(a.style,{textDecoration:'none',padding:'2px 6px',marginRight:'6px',borderRadius:'999px',background:'#f1f5f9',display:'inline-block',fontSize:'12px'});
      lineTags.appendChild(a); });
    card.appendChild(lineTags);

    const link=document.createElement('a'); link.href=`detail.html?id=${z.id}`; link.textContent='💬 コメントを見る/書く';
    Object.assign(link.style,{display:'inline-block',marginTop:'8px'}); card.appendChild(link);

    finishReactionsRender(card, z);
    results.appendChild(card);
  });
})();

/* ================== Topics (index header) ================== */
function getTodayTopics(){
  return [
    'つい買ってしまったもの','パートナーに言えなかったこと','仕事でやらかした小さな失敗',
    '食欲に負けた瞬間','お金の使いすぎ反省','1年前の反省','健康への小さな決意','SNSでのプチ後悔'
  ];
}
(function renderHeaderTopics(){
  const host=document.getElementById('todayTopics'); if(!host) return;
  const topics=getTodayTopics(); host.innerHTML='';
  topics.forEach(t=>{
    const chip=document.createElement('div'); chip.className='topic-chip';
    chip.innerHTML=`<span class="t-label">#${t}</span><a class="t-post" href="post.html?topic=${encodeURIComponent(t)}" title="このお題で投稿">🙏</a>`;
    chip.querySelector('.t-label').addEventListener('click',(e)=>{ e.preventDefault(); location.href=`post.html?topic=${encodeURIComponent(t)}`; });
    host.appendChild(chip);
  });
})();
;(function prefillFromTopic(){
  const form=document.getElementById('postForm'); if(!form) return;
  const params=new URLSearchParams(location.search); const topic=params.get('topic'); if(!topic) return;
  const ta=document.getElementById('zangeText'); const tag=document.getElementById('futureTag');
  if(ta && !ta.value){ ta.value=`#お題「${topic}」 `; ta.dispatchEvent(new Event('input',{bubbles:true})); }
  if(tag){
    const t=topic.replace(/^#+/,''); const now=(tag.value||'').trim();
    const tokens=now?now.replace(/[＃#]/g,'#').split(/[,\s、]+/).filter(Boolean):[]; const token=`#${t}`;
    if(!tokens.map(x=>x.toLowerCase()).includes(token.toLowerCase())) tokens.push(token);
    tag.value=tokens.join(' ');
  }
})();

/* ================== Background picker (post.html) ================== */
(function initBgPicker(){
  const picker=document.getElementById('bgPicker')||document.querySelector('.bg-picker');
  const hidden=document.getElementById('zangeBg'); if(!picker || !hidden) return;
  const firstSel=picker.querySelector('.bg-thumb.selected')||picker.querySelector('.bg-thumb');
  if(firstSel){ hidden.value=firstSel.getAttribute('data-bg')??''; picker.querySelectorAll('.bg-thumb').forEach(el=>el.classList.remove('selected')); firstSel.classList.add('selected'); }
  picker.addEventListener('click',e=>{
    const btn=e.target.closest('.bg-thumb'); if(!btn||!picker.contains(btn)) return;
    picker.querySelectorAll('.bg-thumb').forEach(el=>el.classList.remove('selected')); btn.classList.add('selected');
    hidden.value=btn.getAttribute('data-bg')??'';
  });
})();

/* ================== Notifications ================== */
function getNotificationsFor(uid){ return JSON.parse(localStorage.getItem("notifications_"+uid)||"[]"); }
function saveNotificationsFor(uid,list){ localStorage.setItem("notifications_"+uid, JSON.stringify(list||[])); }
function addNotificationFor(uid,payload){ if(!uid) return; const list=getNotificationsFor(uid); list.unshift({id:"n_"+Date.now(),read:false,ts:new Date().toISOString(),...payload}); saveNotificationsFor(uid,list); }
function updateNotifBadge(){
  const me=getAuthUser(); const badge=document.getElementById("notifBadge");
  if(!badge){ return; }
  if(!me){ badge.style.display="none"; return; }
  const unread=getNotificationsFor(me.id).filter(n=>!n.read).length;
  if(unread>0){ badge.textContent=unread; badge.style.display="inline-block"; }
  else badge.style.display="none";
}
document.addEventListener("DOMContentLoaded", updateNotifBadge);
;(function initNotificationsPage(){
  const list=document.getElementById("notificationList"); if(!list) return;
  const me=getAuthUser(); if(!me){ list.innerHTML="<p>通知を見るにはログインしてください。</p>"; return; }
  const items=getNotificationsFor(me.id);
  if(items.length===0){ list.innerHTML="<p>新しい通知はありません。</p>"; return; }
  list.innerHTML="";
  items.forEach(n=>{
    const li=document.createElement("li"); li.className="card";
    li.innerHTML=`<div>${n.text}</div><small>${new Date(n.ts).toLocaleString()}</small>${n.url?`<a href="${n.url}">投稿を開く</a>`:""}`;
    list.appendChild(li);
  });
  saveNotificationsFor(me.id, items.map(x=>({...x,read:true})));
  updateNotifBadge();
})();

/* ===== Header avatar: lightweight & stable ===== */

/* 1) CSS（1回だけ） */
(function(){
  if (document.getElementById("headerAvatarCss")) return;
  const style = document.createElement("style");
  style.id = "headerAvatarCss";
  style.textContent = `
    .header-avatar-only {
  padding: 0 !important;
  background: transparent !important;
  border: none !important;
  box-shadow: none !important;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
}

.header-avatar-only img.header-avatar-img {
  display: block;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
}

.header-avatar-only .header-avatar-fallback {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #ccc;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}
  `;
  document.head.appendChild(style);
})();

/* 2) 参照先（できるだけ限定） */
function _resolveHeaderBox(){
  return (
    document.getElementById("currentUserIcon") ||
    document.querySelector("#headerUserChip") ||
    document.querySelector(".header-user")
  );
}

/* 3) /api/me は1ページにつき1回だけ */
let _meOnce;
function fetchMeOnce(){
  if (!_meOnce && typeof fetchMe === "function") {
    _meOnce = fetchMe().catch(()=>null);
  }
  return _meOnce || Promise.resolve(null);
}

/* 4) 表示データ取得（ローカル優先 → /api/me → 未ログイン） */
async function _getHeaderAvatarInfo(){
  try{
    const meLocal = (typeof getAuthUser==="function") ? getAuthUser() : null;
    if (meLocal) {
      return {
        loggedIn: true,
        title : meLocal.profile?.nickname || meLocal.email || "ユーザー",
        avatar: meLocal.profile?.avatar || "images/default-avatar.png"
      };
    }
    const svr = await fetchMeOnce();
    if (svr && (svr.email || svr.nickname)){
      const p = (typeof getProfile==="function" ? getProfile() : {}) || {};
      return {
        loggedIn: true,
        title : p.nickname || svr.nickname || svr.email || "ユーザー",
        avatar: p.avatar || "images/default-avatar.png"
      };
    }
  }catch(_){}
  return { loggedIn:false };
}

// ▼ これに置き換え
function _ensureHeaderIconBox(){
  // 既存があればそのまま使う
  let box = document.getElementById('currentUserIcon');
  if (box) return box;

  // about.html は #headerUserChip の“中に”専用コンテナを足す（消さない）
  const isAbout = location.pathname.endsWith('about.html');
  if (isAbout) {
    const chip = document.querySelector('#headerUserChip');
    if (chip) {
      box = chip.querySelector('#currentUserIcon');
      if (!box) {
        box = document.createElement('span');
        box.id = 'currentUserIcon';
        box.className = 'header-avatar-only';
        chip.appendChild(box);               // ← innerHTML を消さない
      }
      return box;
    }
  }

  // その他ページ：既存のユーザー表示領域があれば、その“中に”追加（消さない）
  const holder = document.querySelector(
    '#headerUserChip, .header-user, .nav-user, .user-chip, #headerUser, .header-actions .user, .navbar .user'
  );
  if (holder) {
    box = holder.querySelector('#currentUserIcon');
    if (!box) {
      box = document.createElement('span');
      box.id = 'currentUserIcon';
      box.className = 'header-avatar-only';
      holder.appendChild(box);               // ← 置換せず追加
    }
    return box;
  }

  // 最終フォールバック：ヘッダー末尾に追加
  const header = document.querySelector('header .header-actions, header .container, header, .topbar, .appbar');
  if (header){
    box = document.createElement('span');
    box.id = 'currentUserIcon';
    box.className = 'header-avatar-only';
    header.appendChild(box);
    return box;
  }
  return null;
}

/* 5) 描画（必要なときだけ再利用） */
let _headerRenderedHTML = "";   // 不要な再描画を避ける簡易キャッシュ
async function renderHeaderAvatarOnly(){
  const box = _ensureHeaderIconBox();   // ← ここを差し替え
  if (!box) return false;

  const info = await _getHeaderAvatarInfo();

  // 次に描く HTML を作成（丸アイコン専用）
  let nextHTML = "";
  if (info.loggedIn){
    nextHTML = `
      <img
        src="${info.avatar || "images/default-avatar.png"}"
        alt="${(info.title||"ユーザー").replace(/"/g,"&quot;")}"
        title="${(info.title||"").replace(/"/g,"&quot;")}"
        class="header-avatar-img"
      >
    `;
  }else{
    nextHTML = `
      <div class="header-avatar-fallback">未</div>
    `;
  }

  // 変化なければ描画スキップ
  if (_headerRenderedHTML === nextHTML) return true;

  box.classList.add("header-avatar-only");
  box.innerHTML = nextHTML;

  // フォールバック処理
  const img = box.querySelector("img");
  if (img){
    img.onerror = ()=>{ img.src="images/default-avatar.png"; };
  }

  // クリック動作（既存仕様を踏襲）
  box.style.cursor = "pointer";
  box.onclick = async ()=>{
    const state = await _getHeaderAvatarInfo();
    if (state.loggedIn){
      if (confirm("ログアウトしますか？")){
        if (typeof logoutUser==="function") await logoutUser();
        alert("ログアウトしました");
        location.href="login.html";
      }
    }else{
      if (confirm("ログインしますか？")) location.href="login.html";
    }
  };

  _headerRenderedHTML = nextHTML;
  return true;
}
/* 6) 要素待ち（最大 10 回 / 1 秒）— 重い全 DOM 監視はしない */
// ▼ 置き換え：最大 10回 → 30回（~3秒）に増やす
function waitAndRenderHeader(){
  let tries = 0;
  const tm = setInterval(async ()=>{
    tries++;
    if (await renderHeaderAvatarOnly() || tries >= 30) clearInterval(tm);
  }, 100);
}

/* 7) 軽量イベントでだけ再描画（全部デバウンス） */
const _debounce = (fn, ms=200)=>{
  let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); };
};
const rerender = _debounce(renderHeaderAvatarOnly, 150);

document.addEventListener("DOMContentLoaded", waitAndRenderHeader);
window.addEventListener("pageshow", rerender);
window.addEventListener("focus", rerender);

/* saveProfile をフックして再描画（既存関数があれば） */
(function hookSaveProfile(){
  if (window.__light_hookedSaveProfile) return;
  window.__light_hookedSaveProfile = true;
  const orig = window.saveProfile;
  if (typeof orig === "function") {
    window.saveProfile = function(p){
      const r = orig.apply(this, arguments);
      try{ rerender(); }catch(_){}
      return r;
    };
  }
})();

/* storage 変化時（プロフ関連だけ） */
window.addEventListener("storage", (e)=>{
  if (!e.key) return;
  if (e.key === "profile" || e.key === "profile_owner" || e.key.startsWith("profile:")) rerender();
});
/* ================== settings.html ================== */
async function initProfileUI(){
  const view=document.getElementById("profileView");
  const edit=document.getElementById("profileEdit");
  if(!view || !edit) return;

  // ★ 追加：サーバーセッションがあれば、そのユーザーのメールを
  //   アクティブなプロフィール所有者として同期（無ければ何もしない）
  if (typeof fetchMe === "function") {
    try {
      const me = await fetchMe();
      if (me && me.email) setActiveProfileOwner(me.email);
    } catch (e) {
      // fetchMe が失敗してもローカル保存のプロフィールで続行
    }
  }

  function renderProfileView(p){
    const a=document.getElementById("profileAvatarShow"),
          n=document.getElementById("profileNameShow"),
          g=document.getElementById("profileGenderShow"),
          ag=document.getElementById("profileAgeShow"),
          b=document.getElementById("profileBioShow");
    if(a) a.src=p.avatar||"images/default-avatar.png";
    if(n) n.textContent=p.nickname||"匿名";
    if(g) g.textContent=`性別: ${p.gender||"—"}`;
    if(ag) ag.textContent=`年齢: ${p.age||"—"}`;
    if(b) b.textContent=`自己紹介: ${p.bio||"—"}`;
  }

  function renderProfileEdit(p){
    const nick=document.getElementById("profileNickname"),
          gen=document.getElementById("profileGender"),
          age=document.getElementById("profileAge"),
          bio=document.getElementById("profileBio"),
          prev=document.getElementById("profileAvatarPreview");
    if(nick) nick.value=p.nickname||"";
    if(gen) gen.value=p.gender||"";
    if(age) age.value=p.age||"";
    if(bio) bio.value=p.bio||"";
    if(prev) prev.src=p.avatar||"images/default-avatar.png";
  }

  // ここで改めて現在のプロフィールを取得して描画
  const p=getProfile();
  renderProfileView(p);
  renderProfileEdit(p);

  document.getElementById("editProfileBtn")?.addEventListener("click",()=>{
    view.style.display="none"; edit.style.display="block";
  });

  document.getElementById("profileSaveBtn")?.addEventListener("click",()=>{
    const payload={
      nickname:document.getElementById("profileNickname")?.value?.trim()||"",
      gender:document.getElementById("profileGender")?.value||"",
      age:document.getElementById("profileAge")?.value||"",
      bio:document.getElementById("profileBio")?.value?.trim()||"",
      avatar:document.getElementById("profileAvatarPreview")?.src||"images/default-avatar.png"
    };
    saveProfile(payload);

    // ローカルユーザー一覧（旧仕様）側も同期
    const me=getAuthUser();
    if(me){
      const users=getUsers(); const i=users.findIndex(u=>u.id===me.id);
      if(i>=0){ users[i].profile={...(users[i].profile||{}), ...payload}; saveUsers(users); }
    }

    renderProfileView(payload);
    view.style.display="block"; edit.style.display="none";
    alert("プロフィールを保存しました");
  });

  document.getElementById("profileCancelBtn")?.addEventListener("click",()=>{
    renderProfileEdit(getProfile());
    view.style.display="block"; edit.style.display="none";
  });

  document.getElementById("profileAvatarInput")?.addEventListener("change",(e)=>{
    const f=e.target.files?.[0]; if(!f) return;
    const r=new FileReader();
    r.onload=()=>{ const prev=document.getElementById("profileAvatarPreview"); if(prev) prev.src=r.result; };
    r.readAsDataURL(f);
  });
}
function renderMyPosts(){
  const host=document.getElementById("myPostsList"); if(!host) return;
  const q=(document.getElementById("myPostsSearch")?.value||"").trim().toLowerCase();
  let list=getZanges().filter(z=>isMyPost(z));
  if(q){
    list=list.filter(z=>{
      const text=(z.text||"").toLowerCase();
      const targets=(Array.isArray(z.targets)&&z.targets.length?z.targets.join("、"):(z.target||"").replace(/への懺悔$/u,"")).toLowerCase();
      const tags=(z.futureTag||"").replace(/[＃#]/g,"").toLowerCase();
      return text.includes(q)||targets.includes(q)||tags.includes(q);
    });
  }
  list.sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
  host.innerHTML="";
  if(list.length===0){ host.innerHTML=`<p class="muted">該当する投稿はありません。</p>`; return; }

  list.forEach(z=>{
    const card=document.createElement("div"); card.className="card my-post";
    const title=document.createElement("div"); title.className="zange-caption"; title.textContent=z.text; card.appendChild(title);
    const meta1=document.createElement("small");
    const tgt=Array.isArray(z.targets)?z.targets.join("、"):(z.target||"").replace(/への懺悔$/u,"");
    meta1.textContent=`🙏：${tgt||"—"}`; meta1.style.display="block"; card.appendChild(meta1);
    const meta2=document.createElement("small");
    const tags=(z.futureTag||"").replace(/[＃#]/g,"").split(/[,\uff0c、\s]+/u).map(s=>s.trim()).filter(Boolean).join("、");
    meta2.textContent=`🏷️：${tags||"—"}`; meta2.style.display="block"; card.appendChild(meta2);

    const ops=document.createElement("div"); ops.className="btn-row";
    ops.innerHTML=`
      <button class="btn edit-btn">編集</button>
      <button class="btn primary save-btn" style="display:none">保存</button>
      <button class="btn danger delete-btn right">削除</button>
      <button class="btn share-btn">共有</button>
    `;
    card.appendChild(ops);

    const edit=document.createElement("div"); edit.className="edit-area";
    edit.innerHTML=`
      <div class="field"><label>本文</label><textarea class="e-text" rows="3">${z.text}</textarea></div>
      <div class="row" style="margin-top:6px">
        <div class="field"><label>対象（カンマ区切り）</label><input class="e-targets" type="text" value="${(Array.isArray(z.targets)?z.targets.join(","):"").replace(/"/g,"&quot;")}"></div>
        <div class="field"><label>タグ（カンマ/スペース区切り、#可）</label><input class="e-tags" type="text" value="${(z.futureTag||"").replace(/"/g,"&quot;")}"></div>
        <div class="field" style="max-width:150px"><label>公開範囲</label>
          <select class="e-scope"><option value="public" ${z.scope==="public"?"selected":""}>全体公開</option><option value="private" ${z.scope==="private"?"selected":""}>非公開</option></select>
        </div>
      </div>`;
    card.appendChild(edit);

    const editBtn=ops.querySelector(".edit-btn"),
          saveBtn=ops.querySelector(".save-btn"),
          delBtn=ops.querySelector(".delete-btn"),
          shareBtn=ops.querySelector(".share-btn");

    editBtn.addEventListener("click",()=>{ card.classList.add("editing"); editBtn.style.display="none"; saveBtn.style.display="inline-block"; });
    saveBtn.addEventListener("click",()=>{
      const arr=getZanges(); const target=arr.find(x=>x.id===z.id); if(!target) return;
      target.text=(edit.querySelector(".e-text").value||"").trim()||target.text;
      const tgtStr=(edit.querySelector(".e-targets").value||"").trim();
      target.targets=tgtStr?tgtStr.split(/[,\uff0c、]+/u).map(s=>s.trim()).filter(Boolean):[];
      target.futureTag=(edit.querySelector(".e-tags").value||"").trim();
      target.scope=edit.querySelector(".e-scope").value; saveZanges(arr);

      title.textContent=target.text;
      meta1.textContent=`🙏：${(target.targets||[]).join("、")||"—"}`;
      const tags=(target.futureTag||"").replace(/[＃#]/g,"").split(/[,\uff0c、\s]+/u).map(s=>s.trim()).filter(Boolean).join("、");
      meta2.textContent=`🏷️：${tags||"—"}`;

      card.classList.remove("editing"); editBtn.style.display="inline-block"; saveBtn.style.display="none"; alert("保存しました");
    });
    delBtn.addEventListener("click",()=>{ if(!confirm("この投稿を削除します。よろしいですか？")) return;
      let arr=getZanges(); arr=arr.filter(x=>x.id!==z.id); saveZanges(arr); card.remove(); });
    shareBtn.addEventListener("click", async ()=>{
      const url=location.origin+location.pathname.replace(/[^/]+$/,"")+`detail.html?id=${z.id}`; const text=`${z.text}\n${url}`;
      try{ if(navigator.share) await navigator.share({title:"ZANGE",text,url}); else { await navigator.clipboard.writeText(text); alert("共有用テキストをコピーしました"); } }catch(_){}
    });

    host.appendChild(card);
  });
}
function renderFollowBoxesSafe(){
  const stats=document.getElementById('followStats'),
        boxFing=document.getElementById('followingList'),
        boxFers=document.getElementById('followersList');
  if(!stats || !boxFing || !boxFers) return;

  const me=getAuthUser();
  if(!me){ stats.textContent='未ログイン'; boxFing.innerHTML=''; boxFers.innerHTML=''; return; }
  const users=getUsers();
  const following=(me.following||[]).map(id=>users.find(u=>u.id===id)).filter(Boolean);
  const followers=(me.followers||[]).map(id=>users.find(u=>u.id===id)).filter(Boolean);
  stats.textContent=`フォロー ${following.length} ・ フォロワー ${followers.length}`;

  const render=(list,host,type)=>{
    host.innerHTML=''; if(list.length===0){ host.innerHTML='<p class="muted">なし</p>'; return; }
    list.forEach(u=>{
      const row=document.createElement('div'); Object.assign(row.style,{display:'flex',alignItems:'center',gap:'10px',padding:'6px 0',borderBottom:'1px solid #f0f0f0'});
      const img=document.createElement('img'); img.src=u.profile?.avatar||'images/default-avatar.png';
      Object.assign(img.style,{width:'32px',height:'32px',borderRadius:'50%',objectFit:'cover'}); row.appendChild(img);
      const name=document.createElement('a'); name.href=`user.html?uid=${encodeURIComponent(u.id)}`; name.textContent=u.profile?.nickname||u.email||'ユーザー';
      Object.assign(name.style,{textDecoration:'none',color:'inherit'}); row.appendChild(name);

      const me2=getAuthUser();
      if(me2 && me2.id!==u.id){
        const isFollowing=(me2.following||[]).includes(u.id);
        const btn=document.createElement('button'); btn.className='btn'; btn.style.marginLeft='auto'; btn.dataset.followUser=u.id;
        btn.textContent=(type==='followers')?(isFollowing?'フォロー中':'フォローバック'):'外す';
        btn.addEventListener('click',()=>{
          const now=getAuthUser(); if(!now){ alert('ログインが必要です'); return; }
          if(type==='following'){ unfollowUser(u.id); } else { if(!(now.following||[]).includes(u.id)) followUser(u.id); }
          document.querySelectorAll(`button[data-follow-user="${u.id}"]`).forEach(b=>{
            const fnow=(getAuthUser()?.following||[]).includes(u.id);
            b.textContent = fnow ? 'フォロー中' : (type==='following' ? '外す' : 'フォローバック');
          });
          renderFollowBoxesSafe();
        });
        row.appendChild(btn);
      }
      host.appendChild(row);
    });
  };
  render(following, boxFing, 'following');
  render(followers, boxFers, 'followers');
}
/* Follow tabs underline */
(function initFollowTabs(){
  const tabFers=document.getElementById('tab-followers');
  const tabFing=document.getElementById('tab-following');
  const paneFers=document.getElementById('pane-followers');
  const paneFing=document.getElementById('pane-following');
  const underline=document.querySelector('.follow-tabs .tab-underline');
  if(!tabFers || !tabFing || !paneFers || !paneFing || !underline) return;
  function activate(which){
    const isFollowing=(which==='following');
    tabFers.classList.toggle('active',!isFollowing); tabFing.classList.toggle('active',isFollowing);
    tabFers.setAttribute('aria-selected',!isFollowing?'true':'false'); tabFing.setAttribute('aria-selected',isFollowing?'true':'false');
    paneFers.classList.toggle('show',!isFollowing); paneFing.classList.toggle('show',isFollowing);
    paneFers.hidden=isFollowing; paneFing.hidden=!isFollowing; underline.style.left=isFollowing?'50%':'0%';
  }
  tabFers.addEventListener('click',()=>activate('followers'));
  tabFing.addEventListener('click',()=>activate('following'));
  activate('following');
})();
document.addEventListener('DOMContentLoaded', renderFollowBoxesSafe);

/* settings init */
document.addEventListener('DOMContentLoaded', ()=>{
  initProfileUI();
  renderMyPosts();
  document.getElementById('myPostsSearch')?.addEventListener('input', renderMyPosts);
  if (typeof renderFollowBoxesSafe === 'function') renderFollowBoxesSafe();
});

/* ================== User page (user.html) ================== */
;(function initUserProfilePage(){
  const root=document.getElementById('userProfilePage'); if(!root) return;
  const uid=getParam('uid'); const header=document.getElementById('userHeader'); const posts=document.getElementById('userPostsList');
  const users=getUsers(); const u=users.find(x=>String(x.id)===String(uid));
  if(!u){ header.innerHTML='<p class="muted">ユーザーが見つかりませんでした。</p>'; return; }

  header.innerHTML=''; const row=document.createElement('div'); Object.assign(row.style,{display:'flex',gap:'12px',alignItems:'center'});
  const avatar=document.createElement('img'); avatar.src=u.profile?.avatar||'images/default-avatar.png'; avatar.alt='avatar';
  Object.assign(avatar.style,{width:'72px',height:'72px',borderRadius:'50%',objectFit:'cover'});
  const col=document.createElement('div');
  const name=document.createElement('div'); name.textContent=u.profile?.nickname||u.email||'ユーザー'; Object.assign(name.style,{fontWeight:'800',fontSize:'18px'});
  const bio=document.createElement('div'); bio.className='muted'; bio.textContent=u.profile?.bio||''; col.appendChild(name); if(u.profile?.bio) col.appendChild(bio);
  row.appendChild(avatar); row.appendChild(col);
  const me=getAuthUser();
  if(me && me.id!==u.id){
    const isFollowing=(me.following||[]).includes(u.id);
    const btn=document.createElement('button'); btn.className='btn'; btn.style.marginLeft='auto'; btn.dataset.followUser=u.id;
    btn.textContent=isFollowing?'フォロー中':'フォローする';
    btn.addEventListener('click',()=>{
      const nowMe=getAuthUser(); if(!nowMe){ alert('ログインが必要です'); return; }
      ((nowMe.following||[]).includes(u.id))?unfollowUser(u.id):followUser(u.id);
      const latest=(getAuthUser()?.following||[]).includes(u.id);
      btn.textContent=latest?'フォロー中':'フォローする';
      document.querySelectorAll(`button[data-follow-user="${u.id}"]`).forEach(b=> b.textContent=latest?'フォロー中':'フォローする');
      if(typeof renderFollowBoxesSafe==='function') renderFollowBoxesSafe();
    });
    row.appendChild(btn);
  }
  header.appendChild(row);

  const mine=getZanges()
    .filter(z=>z.scope==='public')
    .filter(z=> String(z.ownerId||'')===String(u.id) ||
      (z.ownerProfile?.nickname && u.profile?.nickname && z.ownerProfile.nickname===u.profile.nickname))
    .sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));

  posts.innerHTML=''; if(mine.length===0){ posts.innerHTML='<p class="muted">公開投稿はまだありません。</p>'; return; }
  mine.forEach(z=>{
    const card=document.createElement('div'); card.className='card';
    const head=buildOwnerInfoByZange(z); if(head) card.appendChild(head);
    if(typeof z.bg==='string' && z.bg.trim()!==''){ const vis=document.createElement('div'); vis.className='zange-visual'; const img=document.createElement('img'); img.src='images/'+z.bg; img.alt='背景画像'; vis.appendChild(img); card.appendChild(vis); }
    const cap=document.createElement('div'); cap.className='zange-caption'; cap.textContent=z.text; card.appendChild(cap);
    const date=document.createElement('small'); date.textContent=`${formatYMD(z.timestamp)}`; card.appendChild(date);

    const lineTargets=document.createElement('small'); lineTargets.appendChild(document.createTextNode('🙏：'));
    const tItems=Array.isArray(z.targets)&&z.targets.length?z.targets:(((z.target||'').replace(/への懺悔$/u,'').trim())?[(z.target||'').replace(/への懺悔$/u,'').trim()]:[]);
    if(tItems.length===0) lineTargets.appendChild(document.createTextNode('—'));
    else tItems.forEach(t=>{ const a=document.createElement('a'); a.href=`search.html?q=${encodeURIComponent(t)}`; a.textContent=t;
      Object.assign(a.style,{textDecoration:'none',padding:'2px 6px',marginRight:'6px',borderRadius:'999px',background:'#f1f5f9',display:'inline-block',fontSize:'12px'}); lineTargets.appendChild(a); });
    card.appendChild(lineTargets);

    const lineTags=document.createElement('small'); lineTags.appendChild(document.createTextNode('🏷️：'));
    const tagItems=((z.futureTag||'').trim()? (z.futureTag||'').replace(/[＃#]/g,'').split(/[,\uff0c、\s]+/u).map(s=>s.trim()).filter(Boolean):[]);
    if(tagItems.length===0) lineTags.appendChild(document.createTextNode('—'));
    else tagItems.forEach(tag=>{ const a=document.createElement('a'); a.href=`search.html?q=${encodeURIComponent(tag)}`; a.textContent=tag;
      Object.assign(a.style,{textDecoration:'none',padding:'2px 6px',marginRight:'6px',borderRadius:'999px',background:'#f1f5f9',display:'inline-block',fontSize:'12px'}); lineTags.appendChild(a); });
    card.appendChild(lineTags);

    const reactions=document.createElement('div'); reactions.className='reactions';
    reactions.innerHTML=`
      <button type="button" onclick="react(${z.id}, 'pray')">🙏 ${z.reactions.pray}</button>
      <button type="button" onclick="react(${z.id}, 'laugh')">😂 ${z.reactions.laugh}</button>
      <button type="button" onclick="react(${z.id}, 'sympathy')">🤝 ${z.reactions.sympathy}</button>
      <button type="button" onclick="react(${z.id}, 'growth')">🌱 ${z.reactions.growth}</button>
      <a href="detail.html?id=${z.id}" style="margin-left:8px;text-decoration:none;">💬 コメント(${Array.isArray(z.comments)?z.comments.length:0})</a>
    `;
    card.appendChild(reactions);
    finishReactionsRender(card, z);

    posts.appendChild(card);
  });
})();

/* ================== Final sweep on DOMContentLoaded ================== */
document.addEventListener('DOMContentLoaded', ()=>{
  // 既に描画済みのカードにも保険でスキン＆＋を適用
  document.querySelectorAll('.card').forEach(card=>{
    const link=card.querySelector('a[href^="detail.html?id="]');
    const id=link?Number(new URL(link.href, location.href).searchParams.get('id')):null;
    const z=(id && getZanges().find(x=>Number(x.id)===id)) || null;
    finishReactionsRender(card, z||{id:0,reactions:{}});
  });
});
// ===== サーバー側認証版 =====
async function registerUser(email, pass, { nickname = "" } = {}) {
  const res = await fetch("/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ email, password: pass, nickname })
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok && data.user) {
    setActiveProfileOwner(data.user.email);
    // プロフィール初期化（無ければ）
    const existed = getProfile();
    if (!existed || Object.keys(existed).length === 0) {
      saveProfile({
        nickname: data.user.nickname || data.user.email || "匿名",
        avatar: "images/default-avatar.png",
        gender: "",
        age: "",
        bio: ""
      });
    }
    return true;
  }
  return false;
}

async function loginUser(email, pass) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ email, password: pass })
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok && data.user) {
    setActiveProfileOwner(data.user.email);
    // 既存プロフが無ければ最低限を用意
    const prof = getProfile();
    if (!prof || Object.keys(prof).length === 0) {
      saveProfile({
        nickname: data.user.nickname || data.user.email || "匿名",
        avatar: "images/default-avatar.png",
        gender: "",
        age: "",
        bio: ""
      });
    }
    // サーバー版 loginUser 内の return true の直前あたりに1行追加
ensureLocalAuthFromActiveOwner();
    return true;
  }
  return false;
}

async function logoutUser() {
  await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  // アクティブオーナーを解除（次回は旧互換の "profile" を参照）
  setActiveProfileOwner("");
  return true;
}

async function fetchMe() {
  const res = await fetch("/api/me", { credentials: "same-origin", cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (data && data.ok && data.user) {
    // /api/me ベースでオーナーを同期させる（タブ再読込時など）
    setActiveProfileOwner(data.user.email || "");
    return data.user;
  }
  return null;
}

/* ====== Per-user Profile namespace (fix for settings page) ====== */
function _profileKeyFor(email){
  const e = (email || "").trim().toLowerCase();
  return e ? `profile:${e}` : "profile";
}
function setActiveProfileOwner(email){
  localStorage.setItem("profile_owner", (email || "").trim().toLowerCase());
}
function getActiveProfileOwner(){
  return (localStorage.getItem("profile_owner") || "").trim().toLowerCase();
}
// ★追加：サーバーのアクティブオーナー(email)からローカル users/auth を同期
function ensureLocalAuthFromActiveOwner(){
  const email = (typeof getActiveProfileOwner === "function" ? getActiveProfileOwner() : "") || "";
  if (!email) return null;

  const users = getUsers();
  let u = users.find(x => x.email === email);

  // なければローカルに“殻ユーザー”を作る（プロフィールは local のものを利用）
  if (!u) {
    const p = (typeof getProfile === "function" ? getProfile() : {}) || {};
    u = {
      id: uid(),
      email,
      pass: "",
      profile: {
        nickname: p.nickname || email || "匿名",
        avatar:   p.avatar   || "images/default-avatar.png",
        gender:   p.gender   || "",
        age:      p.age      || "",
        bio:      p.bio      || ""
      },
      following: [],
      followers: []
    };
    users.push(u);
    saveUsers(users);
  }

  // authUserId が未設定なら紐づける
  if (!getAuthId()) setAuthId(u.id);

  return u;
}
