// The portal's "Resume Flow" button reaches the daemon as a resume request.
// Before clearing the local pause, look at the Flow tab — read-only: no
// clicks, no typing, no generation. An unknown outcome is only resumed when
// the owner asked for it AND Flow itself looks ready.
import { connectTab, evalJson } from './flow-lib.mjs';
import { WARNING } from './flow-safety.mjs';

const PAGE = `(() => ({ url: location.href, text: document.body.innerText.slice(0, 20000), composer: !!Array.from(document.querySelectorAll('*')).find(e => (e.textContent || '').trim() === 'What do you want to create?') }))()`;

// Pure decision on what the tab shows. Exported for tests.
export function resumeVerdict(page) {
  if (!page) return { ok: false, reason: 'The Flow tab could not be read' };
  if (/accounts\.google\.com/.test(page.url)) return { ok: false, reason: 'Google is signed out in the Flow Chrome window; sign in there first' };
  const warning = page.text.match(WARNING);
  if (warning) return { ok: false, reason: `Flow shows a warning ("${warning[0]}"); wait it out before resuming` };
  if (/\bfailed\b[\s\S]{0,500}you have not been charged/i.test(page.text)) return { ok: false, reason: 'Flow shows a failed-generation card; check it before resuming' };
  if (!/flow\.google\.com\/project\//.test(page.url)) return { ok: false, reason: 'The Flow Chrome window is not on the Flow project page' };
  if (!page.composer) return { ok: false, reason: "Flow's prompt box is not visible (page still loading or changed)" };
  return { ok: true };
}

export async function checkFlowForResume() {
  let tab;
  try {
    tab = await connectTab();
    return resumeVerdict(await evalJson(tab.send, PAGE));
  } catch (err) {
    return { ok: false, reason: `Chrome/Flow is not reachable: ${String(err?.message ?? err).slice(0, 160)}` };
  } finally {
    try { tab?.ws.close(); } catch {}
  }
}
