import { CAT_ICON_POOL } from "./icons";
export const ICON = CAT_ICON_POOL[0];

export const STYLES = `
[data-component="InputArea"] button[data-cat-stop] { background:var(--lumiverse-danger, #ef4444)!important; color:var(--lumiverse-primary-contrast, #fff)!important; }
[data-component="InputArea"] button[data-cat-stop]:not(:disabled) { opacity:1!important; cursor:pointer!important; }
[data-component="InputArea"] button[data-cat-stop]:hover { background:var(--lumiverse-danger-hover, #dc2626)!important; }
[data-component="InputArea"] button[data-cat-stop] > * { visibility:hidden!important; }
[data-component="InputArea"] button[data-cat-stop]::after { display:none!important; }
[data-component="InputArea"] button[data-cat-stop]::before { content:""; position:absolute; width:12px; height:12px; border:2px solid currentColor; border-radius:2px; box-sizing:border-box; }
.ao-icon-credits { display:inline-block; margin:12px 4px 0; color:var(--ao-muted); text-underline-offset:3px; }
.ao-icon-credits:hover { color:var(--ao-text); }
/* LumiBooks' scoped host-padding override; keep the bottom safe-area inset. */
:has(> div > [data-spindle-drawer-tab] > .ao-root) {
  padding-top:0!important; padding-left:0!important; padding-right:0!important;
}
[data-spindle-drawer-tab]:has(> .ao-root) { height:100%; min-height:0; }
.ao-root {
  --ao-text:var(--lumiverse-text, #eee9f3);
  --ao-muted:var(--lumiverse-text-muted, #b7afc5);
  --ao-accent:var(--lumiverse-primary-text, var(--lumiverse-primary, #b5a2d9));
  --ao-success:var(--lumiverse-success, var(--ao-accent));
  --ao-error:var(--lumiverse-danger, var(--ao-accent));
  --ao-bg:var(--lumiverse-bg, #15121d);
  --ao-panel:var(--lumiverse-bg-elevated, #221c2e);
  --ao-line:var(--lumiverse-border, color-mix(in srgb, var(--ao-text) 16%, transparent));
  --ao-glass:color-mix(in srgb, var(--ao-panel) 86%, transparent);
  display:flex; flex-direction:column; height:100%; min-height:0; min-width:0;
  color:var(--ao-text); background:var(--ao-bg);
  font-family:var(--lumiverse-font-family, 'Segoe UI', sans-serif); font-size:12px; line-height:1.45;
}
.ao-root *, .ao-root *::before, .ao-root *::after { box-sizing:border-box; }
.ao-root:not(.ao-hotbar) { container-type:inline-size; }
.ao-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:4px; padding:6px 8px; min-height:48px; border-bottom:1px solid var(--ao-line); background:var(--ao-bg); flex-shrink:0; }
.ao-tabs { display:flex; flex:1 1 auto; flex-wrap:wrap; min-width:0; gap:4px; }
.ao-tab { display:inline-flex; align-items:center; justify-content:center; gap:6px; border:1px solid transparent; border-radius:999px; background:none; color:var(--ao-muted); padding:5px 8px; font:inherit; font-size:11px; cursor:pointer; transition:background .2s, color .2s, box-shadow .2s; }
.ao-tab[aria-selected=true] { color:var(--ao-accent); background:color-mix(in srgb, var(--ao-accent) 12%, transparent); border-color:var(--ao-line); box-shadow:0 2px 8px #00000012; }
.ao-tab:hover { color:var(--ao-text); background:color-mix(in srgb, var(--ao-accent) 8%, transparent); }
.ao-cat-icon { width:24px; height:24px; flex-shrink:0; color:var(--ao-accent); }
.ao-tab .ao-cat-icon { width:24px; height:24px; }
.ao-body { position:relative; isolation:isolate; overflow:hidden; display:flex; flex:1; min-height:0; }
.ao-cats { position:absolute; inset:0; z-index:-2; overflow:hidden; opacity:0; pointer-events:none; transition:opacity .35s; }
.ao-cat { display:block; width:100%; height:auto; object-fit:contain; }
.ao-with-cat .ao-cats { opacity:.7; }
.ao-with-cat .ao-cats-enter { animation:ao-gallery-in .35s ease both; }
.ao-body::before { content:''; position:absolute; inset:0; z-index:-1; pointer-events:none; background:linear-gradient(165deg, color-mix(in srgb, var(--ao-bg) 28%, transparent), color-mix(in srgb, var(--ao-bg) 48%, transparent)); }
.ao-content { flex:1; min-height:0; min-width:0; padding:14px 12px 24px; overflow:auto; scrollbar-width:thin; scrollbar-color:var(--ao-line) transparent; }
.ao-button { border:1px solid var(--ao-line); border-radius:999px; background:var(--ao-glass); color:var(--ao-text); font:inherit; padding:7px 12px; cursor:pointer; line-height:1.35; backdrop-filter:blur(12px); box-shadow:0 3px 10px #00000012; transition:transform .18s, box-shadow .18s, border-color .18s, background .18s; }
.ao-button:hover:not(:disabled) { border-color:color-mix(in srgb, var(--ao-accent) 60%, transparent); transform:translateY(-1px); box-shadow:0 5px 14px #00000024; }
.ao-button:active:not(:disabled) { transform:translateY(1px) scale(.98); }
.ao-toggle { color:var(--ao-accent); min-width:68px; padding:6px 11px; font-size:11px; flex-shrink:0; margin-left:auto; white-space:nowrap; }
.ao-toggle[aria-pressed=true] { background:color-mix(in srgb, var(--ao-accent) 14%, var(--ao-panel)); }
.ao-toggle::before { content:''; display:inline-block; width:5px; height:5px; border-radius:50%; background:currentColor; margin-right:6px; opacity:.6; vertical-align:2px; }
.ao-toggle[aria-pressed=true]::before { background:var(--ao-success); opacity:1; box-shadow:0 0 7px color-mix(in srgb,var(--ao-success) 20%,transparent); }
.ao-small { padding:3px 6px; min-width:25px; min-height:25px; }
.ao-button:disabled, .ao-input:disabled { opacity:.48; cursor:default; }
.ao-root :focus-visible { outline:2px solid var(--ao-accent); outline-offset:2px; }
.ao-pill { display:inline-flex; align-items:center; gap:7px; max-width:100%; border:1px solid var(--ao-line); border-radius:999px; padding:7px 11px; background:var(--ao-glass); color:var(--ao-text); backdrop-filter:blur(14px); box-shadow:0 4px 14px #0000001c, inset 0 1px 0 #ffffff06; }
.ao-status { display:flex; width:fit-content; gap:7px; min-height:33px; margin-bottom:16px; border-radius:17px; }
.ao-status .ao-cat-icon { animation:ao-cat-float 4s ease-in-out infinite; }
.ao-status-text { margin:0; flex:1; font-size:11px; line-height:1.55; }
.ao-dot { width:6px; height:6px; border-radius:50%; background:var(--ao-muted); flex-shrink:0; }
.ao-ready .ao-dot { background:var(--ao-success); }
.ao-running .ao-dot, .ao-preparing .ao-dot { background:var(--ao-accent); animation:ao-pulse 1.4s infinite; }
.ao-error .ao-dot { background:var(--ao-error); }
.ao-muted, .ao-empty { color:var(--ao-muted); margin:8px 0; font-size:11px; }
.ao-empty { border-radius:18px; padding:12px 14px; }
.ao-run { margin-bottom:12px; padding:12px; border:1px solid var(--ao-line); border-radius:18px; background:var(--ao-glass); backdrop-filter:blur(10px); box-shadow:0 6px 22px #00000020, inset 0 1px 0 #ffffff06; animation:ao-card-in .3s ease both; }
.ao-run-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding-bottom:5px; }
.ao-run-title { min-width:0; flex:1; display:flex; align-items:center; flex-wrap:wrap; gap:5px; }
.ao-run-title .ao-pill { padding:5px 8px; font-size:11px; }
.ao-run-title strong { display:inline-flex; font-weight:600; overflow-wrap:anywhere; }
.ao-run-character { min-width:0; overflow-wrap:anywhere; }
.ao-run-date { color:var(--ao-muted); font-size:11px; overflow-wrap:anywhere; }
.ao-step-state { color:var(--ao-accent); font-size:9px; text-transform:capitalize; padding:3px 7px; border-radius:999px; background:color-mix(in srgb, var(--ao-accent) 9%, transparent); white-space:nowrap; }
.ao-step-error { color:var(--ao-error); background:color-mix(in srgb,var(--ao-error) 8%,transparent); }
.ao-step { display:flex; align-items:center; gap:9px; padding:10px 4px; border:0; border-bottom:1px solid var(--ao-line); width:100%; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; border-radius:9px; transition:background .2s, transform .2s; }
.ao-step:hover:not(:disabled) { color:var(--ao-accent); background:color-mix(in srgb, var(--ao-accent) 7%, transparent); transform:translateX(2px); }
.ao-step:disabled { cursor:default; opacity:.55; }
.ao-run-past { opacity:.52; filter:grayscale(.8); user-select:none; }
.ao-run-past .ao-step { pointer-events:none; }
.ao-step:last-child { border-bottom:0; padding-bottom:0; }
.ao-step-number { display:grid; place-items:center; color:var(--ao-accent); min-width:22px; height:22px; border-radius:50%; background:color-mix(in srgb, var(--ao-accent) 9%, transparent); font-size:10px; }
.ao-step-copy { flex:1; min-width:0; }
.ao-step-copy strong { display:block; font-size:12px; font-weight:500; overflow-wrap:anywhere; }
.ao-step-copy small { display:block; font-size:11px; color:var(--ao-muted); overflow-wrap:anywhere; }
.ao-settings-intro { display:flex; align-items:center; flex-wrap:wrap; gap:7px; margin-bottom:16px; }
.ao-hint { margin:0; font-size:10px; line-height:1.5; }
.ao-count { font-size:10px; color:var(--ao-accent); padding:5px 8px; }
.ao-slots { position:relative; display:flex; flex-direction:column; gap:16px; margin:10px 0; }
.ao-slot { position:relative; isolation:isolate; padding:12px; border:1px solid var(--ao-line); border-radius:18px; background:var(--ao-glass); backdrop-filter:blur(10px); box-shadow:0 6px 22px #00000020, inset 0 1px 0 #ffffff06; transition:box-shadow .2s, border-color .2s, transform .2s; }
.ao-slot::before, .ao-slot::after { content:''; position:absolute; z-index:-1; top:-5px; width:11px; height:11px; border-top:1px solid var(--ao-line); border-left:1px solid var(--ao-line); background:var(--ao-panel); transform:rotate(45deg); border-radius:3px 0 0; }
.ao-slot::before { left:19px; }
.ao-slot::after { left:47px; }
.ao-slot:hover, .ao-slot:focus-within { border-color:color-mix(in srgb, var(--ao-accent) 34%, transparent); box-shadow:0 9px 26px #0000002a; }
.ao-slot-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.ao-slot-name { display:inline-flex; align-items:center; gap:5px; font-size:10px; color:var(--ao-accent); padding:3px 7px; border-radius:999px; background:color-mix(in srgb, var(--ao-accent) 8%, transparent); }
.ao-slot-controls { display:flex; gap:3px; }
.ao-slot-controls .ao-button { background:color-mix(in srgb, var(--ao-bg) 50%, transparent); border-color:transparent; box-shadow:none; }
.ao-drag-handle { cursor:grab; touch-action:none; font-size:17px; line-height:1; }
.ao-dragging { transform:rotate(-1.2deg) scale(1.025); opacity:.96; border-color:var(--ao-accent); box-shadow:0 18px 44px #00000066, 0 0 0 3px color-mix(in srgb, var(--ao-accent) 10%, transparent); z-index:5; cursor:grabbing; }
.ao-dragging .ao-drag-handle { cursor:grabbing; }
.ao-drag-gap { flex-shrink:0; display:flex; align-items:center; justify-content:center; gap:7px; border:1px dashed color-mix(in srgb, var(--ao-accent) 48%, transparent); border-radius:18px; background:color-mix(in srgb, var(--ao-accent) 6%, transparent); color:var(--ao-accent); font-size:11px; }
.ao-field { display:flex; flex-direction:column; gap:4px; margin-top:9px; min-width:0; }
.ao-label { font-size:10px; color:var(--ao-muted); }
.ao-input { width:100%; min-width:0; color:var(--ao-text); background:color-mix(in srgb, var(--ao-bg) 64%, transparent); border:1px solid var(--ao-line); border-radius:10px; padding:8px 9px; font:inherit; font-size:11px; }
.ao-input option { background:var(--ao-bg); color:var(--ao-text); }
.ao-actions { display:flex; gap:7px; flex-wrap:wrap; margin-top:14px; }
.ao-notice { padding:8px 12px; margin:8px 12px 0; background:var(--ao-panel); font-size:11px; border:1px solid var(--ao-line); border-radius:16px; }
.ao-notice:empty { display:none; }
.ao-lock-cover { position:absolute; z-index:2; inset:0; width:100%; height:100%; background:transparent!important; border:0!important; box-shadow:none!important; border-radius:18px; cursor:pointer; backdrop-filter:none; transform:none!important; }
.ao-lock-tip { position:absolute; z-index:4; top:11px; left:50%; transform:translateX(-50%); font-size:11px; white-space:nowrap; background:var(--ao-panel); border-color:color-mix(in srgb, var(--ao-accent) 45%, transparent); box-shadow:0 6px 24px #00000040; pointer-events:none; animation:ao-pop-in .35s cubic-bezier(.16,1.5,.4,1) both; }

.ao-cat-view { display:block; overflow-y:auto; scrollbar-width:thin; scrollbar-color:var(--ao-line) transparent; }
.ao-cat-view .ao-cats { position:relative; inset:auto; z-index:0; overflow:visible; opacity:1; pointer-events:auto; }
.ao-cat-view .ao-content, .ao-cat-view::before { display:none; }
.ao-cat-loading { display:flex; position:sticky; bottom:18px; z-index:1; width:max-content; max-width:calc(100% - 32px); margin:24px auto; font-size:11px; animation:ao-cat-bob 3s ease-in-out infinite; }
.ao-cat-loading > .ao-pill { position:relative; z-index:1; padding:8px 14px; box-shadow:0 6px 24px #00000035; }
.ao-cat-loading[hidden] { display:none; }
.ao-cat-stars { position:absolute; inset:0; pointer-events:none; }
.ao-cat-star { position:absolute; top:5px; left:calc(12% + var(--star) * 19%); color:var(--ao-accent); font-size:14px; text-shadow:0 1px 4px var(--ao-bg); opacity:0; animation:ao-cat-spark 2.8s ease-out infinite; animation-delay:calc(var(--star) * -.56s); }
.ao-slot-name .ao-cat-icon { width:26px; height:26px; }
.ao-slot { border-top-left-radius:25px; border-top-right-radius:25px; }
.ao-hotbar-profile .ao-cat-icon { width:22px; height:22px; }
@container (max-width:360px) { .ao-tab { gap:3px; padding:5px; } .ao-tab .ao-cat-icon { width:21px; height:21px; } .ao-toggle { min-width:0; padding:6px 8px; } }

@keyframes ao-pulse { 50% { opacity:.35; } }
.ao-waiting-cat { display:inline-flex; align-items:center; gap:12px; padding:10px 16px; margin:4px 0; border:1px solid color-mix(in srgb,currentColor 18%,transparent); border-radius:999px; color:var(--lumiverse-primary-text,var(--lumiverse-text-muted,#b7afc5)); background:color-mix(in srgb,currentColor 6%,transparent); font-size:12px; }
.ao-wait-cat { width:30px; height:30px; flex:none; fill:currentColor; animation:ao-cat-spin 3s linear infinite; }
@keyframes ao-cat-spin { to { transform:rotate(360deg); } }
@media(prefers-reduced-motion:reduce) { .ao-wait-cat { animation:none; } }
@keyframes ao-cat-float { 50% { transform:translateY(-2px) rotate(-5deg); } }
@keyframes ao-cat-bob { 50% { transform:translateY(-5px) rotate(-1deg); } }
@keyframes ao-cat-spark { 0% { opacity:0; transform:translate(0,0) scale(.3); } 20% { opacity:.9; transform:translate(calc((var(--star) - 2) * 4px),-8px) rotate(20deg) scale(1); } 100% { opacity:0; transform:translate(calc((var(--star) - 2) * 14px),-42px) rotate(100deg) scale(.35); } }
@keyframes ao-gallery-in { from { opacity:0; } to { opacity:.7; } }
@keyframes ao-card-in { from { opacity:.3; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
@keyframes ao-pop-in { from { opacity:0; transform:translateX(-50%) translateY(8px) scale(.75) rotate(-5deg); } to { opacity:1; transform:translateX(-50%) translateY(0) scale(1) rotate(0); } }
@media(prefers-reduced-motion:reduce) { .ao-root * { animation:none!important; transition:none!important; } }
.ao-root.ao-hotbar { position:fixed; z-index:10000; width:min(340px, calc(var(--app-scaled-viewport-width, 100vw) - 16px)); height:auto; max-height:calc(var(--app-scaled-viewport-height, 100vh) * .75); overflow:auto; display:flex; gap:4px; padding:10px; border:1px solid var(--ao-line); border-radius:18px; background:color-mix(in srgb,var(--ao-panel) 96%,transparent); box-shadow:0 12px 40px #0006; backdrop-filter:blur(18px); animation:ao-card-in .18s ease-out; }
.ao-hotbar-title { display:flex; align-items:center; gap:8px; padding:5px 8px; font-size:12px; color:var(--ao-muted); }
.ao-hotbar .ao-button { width:100%; text-align:left; padding:9px 10px; border:1px solid transparent; border-radius:12px; box-shadow:none; background:transparent; }
.ao-hotbar .ao-button:hover { background:color-mix(in srgb,var(--ao-accent) 10%,transparent); }
.ao-hotbar .ao-button:focus-visible { outline:2px solid var(--ao-accent); outline-offset:-2px; }
.ao-hotbar .ao-hotbar-profile { display:flex; align-items:center; gap:10px; font-size:13px; }
.ao-hotbar-profile > span:last-child { min-width:0; overflow-wrap:anywhere; }
.ao-hotbar-profile[aria-checked=true] { border-color:var(--ao-line); color:var(--ao-accent); background:color-mix(in srgb,var(--ao-accent) 7%,transparent); }
.ao-hotbar-state { font-size:10px; font-weight:700; min-width:22px; opacity:.7; }
.ao-hotbar .ao-hotbar-required:disabled { opacity:1; cursor:default; }
.ao-hotbar-hint { margin:6px 8px; font-size:10px; color:var(--ao-muted); }
.ao-hotbar .ao-hotbar-manage { color:var(--ao-accent); border-top:1px solid var(--ao-line); border-radius:0 0 10px 10px; }
.ao-hotbar-trigger { position:relative; display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px; padding:5px; border:0; border-radius:8px; background:transparent; color:var(--lumiverse-text-muted,#b7afc5); cursor:pointer; transition:background .18s,color .18s; }
.ao-hotbar-trigger .ao-cat-icon { width:24px; height:24px; }
.ao-hotbar-trigger:hover,.ao-hotbar-trigger[aria-expanded=true] { color:var(--lumiverse-primary-text,#d3b4ff); background:color-mix(in srgb,currentColor 12%,transparent); }
.ao-hotbar-trigger:focus-visible { outline:2px solid var(--lumiverse-primary-text,#d3b4ff); outline-offset:2px; }
.ao-hotbar-trigger[data-enabled=true]::after { content:""; position:absolute; right:3px; top:3px; width:4px; height:4px; border-radius:50%; background:var(--lumiverse-success,var(--lumiverse-primary-text,#b5a2d9)); }
`;
