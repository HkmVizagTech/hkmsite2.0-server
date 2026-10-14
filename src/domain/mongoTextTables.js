// Generated from probing MongoDB 7 text index v3 (english): codepoint ranges in base 36.
// DELIMITERS split tokens; STRIPPED are dropped inside a token; FOLD_NFD are decomposed to their base letter.
const parse = (s) =>
  s.split(",").map((r) => {
    const [a, b] = r.split("-");
    return [parseInt(a, 36), parseInt(b ?? a, 36)];
  });
export const DELIMITERS = parse(
  "9-d,w-12,14-1b,1m-1s,2j-2m,2o,3f-3i,3p,4g-4n,4p,4r-4u,4w-4x,52,57,5b,5z,6v,ou,p3,13d-13e,14u,14z,170,17f,17j,1ck,1ds-1e2,1e4,1ko-1kp,1m8-1mm,1ni,1us-1ut,2u2-2u3,2yw,2z1-2z6,37u-37v,3tt-3u0,3y8,4fh-4fi,4g0,4iz-4j1,4l1-4l2,4pg-4pi,4pm,4qq-4qu,4qw-4qx,4zo-4zp,59k-59n,5ei-5ej,5el-5en,5kr-5kv,5mm-5mn,6bk-6bu,6c0-6cp,6cv-6da,6dd-6dv,6dx-6e7,6ez,6ff,6mo-76n,7b4-7sl,7tg-8ov,934-96n,9hc-9hf,9hk-9i8,9io,9ls,9ob,wla-wlb,wst-wsv,wz7-wzb,x9y-x9z,xce-xcf,xf3,xjb-xjd,xnh-xnj,xr3,xrk-xrl,xyj,1e0u-1e0v,1e7l-1e7m,1e81-1e86,1e8g-1e8i,1e8k-1e8o,1e8z,1edd-1ede,1edj,1edo-1edq,1ee2-1ee3,1ee7,1eg1-1eg5,1fa7,1fbk,1g7r,1gdb,1gly-1glz,1gq8-1gqd,1gsa-1gsf,1gux-1gv0,1hs7-1hsd,1hvi-1hvl,1hz5-1hz7,1i2t-1i2u,1i31,1i3i-1i3j,1i60-1i64,1i95,1iv6-1iv9,1ivd-1ivr,1iyp-1iyq,1j5o-1j5q,1lrk-1lro,1zla-1zlb,1zp1,1zqv-1zqx,1zr8,2ftr,2lqf-2lqi"
);
export const STRIPPED = parse(
  "4o,4v,50,53-54,j4-n8,na-ni,nk-nr,nx-o2,ok-ol,oq,p0-p1,w3-w7,121,13l-141,143-14t,14v,14x-14y,150,18r-18y,193-194,1cv-1cw,1d1-1d2,1d6-1d8,1f4-1fu,1ie-1io,1kb-1kl,1lk-1ll,1r7-1ry,1to,1u5,1u9-1uc,1v5,1x8,1xp,20s,219,24c,24t,27w,28d,2bx,2fh,2ik,2j1,2ml,2q2,2tj-2to,2tq,2x4-2x8,2zc-2zd,305,307,309,30e-30f,32a-32c,32e-32f,346,37b,37d-37e,39j-39p,39r,3a2-3a3,4p5-4pf,4pp,4zd-4zf,585-58c,58f,59s-5a5,5dg,5dw,5ez-5f7,5gq-5gr,5km-5kn,5mg-5ml,5ow-5pk,5pp,5pw,5q0-5q1,5rg-5t6,5vo-5vz,5x1,5x9-5xb,69p,69r-69t,6a5-6a7,6al-6an,6b1-6b3,6bh-6bi,8vj-8vl,9ii-9in,9ll-9lo,9oc,wvj,wvw-wvx,wvz,wws-wwt,wz4-wz5,x07-x0h,x3c,x6g-x6h,xc4,xcw-xdd,xez-xf2,xg3,xir,xj4,xk5,xob-xod,xq7-xqa,xrq,xuj-xun,xyk-xyl,1dlq,1e74-1e7j,1edb,1ef2,1ef4,1egg,1ehq-1ehr,1ejn,1f4w,1gpx-1gpy,1hvd-1hve,1hyr-1hys,1i0j,1i2o,1i2y-1i30,1i5x-1i5y,1iax-1iay,1id8,1idp,1iee-1iek,1ieo-1ies,1io2-1io3,1iv3-1iv4,1iyn,1j1y-1j1z,1j57,1zow-1zp0,20lr-20m7,2jxj-2jxl,2jxp-2jxu,2jy3-2jya,2jyd-2jyj,2jze-2jzh,2ok0-2ok6"
);
export const FOLD_NFD = parse(
  "5c-5h,5j-5r,5t-5y,61-65,68-6d,6f-6n,6p-6u,6x-71,73-7j,7m-85,88-8f,8k-8n,8p-8u,8z-94,98-9d,9g-9x,a0-am,bk-bl,bz-c0,ct-d8,da-df,di-ds,dw-dx,e0-ez,f2-f3,fa-fn,p2,p4-p6,p8,pa-pc,q2-q8,qy-r2,r7-r8,sg-sh,sj,sn,ss-su,t5,u1,uo-up,ur,uv,v0-v2,vq-vr,xt-xu,y8-yb,ye-yf,yi-yn,yq-yv,yy-z9,zc-zd,1t5,1td,1tg,1ug-1un,1y4-1y5,1y7,20j,20m,21l-21n,21q,28s-28t,5xc-61l,61n,61s-649,64g-651,654-659,65c-66d,66g-66l,66o-66v,66x,66z,671,673-67x,680-69g,69i-69o,69q,69u-69w,69y-6a4,6a8-6ab,6ae-6aj,6ao-6b0,6b6-6b8,6ba-6bg,6jv,9jg,9ji,9jk,9jm,9jo,9jq,9js,9ju,9jw,9jy,9k0,9k2,9k5,9k7,9k9,9kg-9kh,9kj-9kk,9km-9kn,9kp-9kq,9ks-9kt,9lg,9lq,9m4,9m6,9m8,9ma,9mc,9me,9mg,9mi,9mk,9mm,9mo,9mq,9mt,9mv,9mx,9n4-9n5,9n7-9n8,9na-9nb,9nd-9ne,9ng-9nh,9o4,9o7-9oa,9oe,1d6o-1de5,1de8,1dea,1ded-1dem,1deo,1deq,1det-1deu,1dey-1dgt,1dgw-1djt,1dlp,1dlr,1dm2-1dme,1dmg-1dmk,1dmm,1dmo-1dmp,1dmr-1dms,1dmu-1dn2,1hui,1huk,1huz,464g-46jh"
);
