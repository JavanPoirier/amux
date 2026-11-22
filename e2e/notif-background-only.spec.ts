// The owner, 2026-11-22: "I do want push notifications if the app is put in
// the background, not while I'm actively in it", no notification for a worker
// starting or stopping while "I am in a worker and viewing its terminal", and
// starting a worker specifically not notified. Settings > Notifications > This
// device carries "Only when amux is in the background" (default on) and a
// per-kind list ("Started working" off by default). The server half: a device
// reporting it is in front is held back from web push (push/mod.rs presence).
import { test, expect } from './fixtures';

async function openNotifSettings(page) {
  await page.evaluate(() => { (window as any).toggleSettings(); (window as any)._settingsTab('device'); });
  await expect(page.locator('#notif-device-bgonly-cb')).toBeAttached();
}

// Notification permission granted, a service worker whose showNotification is
// counted, and visibility/focus the test controls.
const fakeDevice = () => {
  const w = window as any;
  w._native = [];
  w._front = true;
  w.Notification = class { static permission = 'granted'; static requestPermission = async () => 'granted'; constructor(t: string) { w._native.push(t); } };
  if (!('PushManager' in window)) w.PushManager = function PushManager() {};
  const reg = {
    showNotification: async (t: string) => { w._native.push(t); },
    pushManager: { getSubscription: async () => ({ endpoint: 'https://push.example/dev1', toJSON: () => ({}) }) },
  };
  Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { configurable: true, get: () => Promise.resolve(reg) });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (w._front ? 'visible' : 'hidden') });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => !w._front });
  document.hasFocus = () => w._front;
  localStorage.setItem('amux_walkthrough_done', '1');
  localStorage.setItem('amux_notifs', '1');
};

const banners = (page) => page.locator('#notif-banners .notif-banner');
const fire = (page, name: string, kind: string) =>
  page.evaluate(([n, k]) => (window as any)._fireSessionNotif(n, n + ' ' + k, '', k), [name, kind]);

test('settings: background-only is on by default, started is muted by default, both persist', async ({ page }) => {
  await page.addInitScript(fakeDevice);
  await page.goto('/');
  await openNotifSettings(page);
  await expect(page.locator('#notif-device-bgonly-cb')).toBeChecked();
  const started = page.locator('#notif-kinds-list input[data-notif-kind="started"]');
  const stopped = page.locator('#notif-kinds-list input[data-notif-kind="stopped"]');
  await expect(page.locator('#notif-kinds-list input')).toHaveCount(7);
  await expect(started).not.toBeChecked();
  await expect(stopped).toBeChecked();

  await page.locator('#notif-device-bgonly-cb + .theme-track').click();
  await expect(page.locator('#notif-device-bgonly-cb')).not.toBeChecked();
  await stopped.click();
  await expect(stopped).not.toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('amux_notif_bg_only'))).toBe('0');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('amux_notif_kinds') || '{}').stopped)).toBe(false);

  await page.reload();
  await openNotifSettings(page);
  await expect(page.locator('#notif-device-bgonly-cb')).not.toBeChecked();
  await expect(page.locator('#notif-kinds-list input[data-notif-kind="stopped"]')).not.toBeChecked();
});

test('in front: an in-app pop-up and no device notification; in the background: a device notification', async ({ page }) => {
  await page.addInitScript(fakeDevice);
  await page.goto('/');
  await page.waitForFunction(() => typeof (window as any)._fireSessionNotif === 'function');
  await page.evaluate(() => document.body.classList.remove('intent-simple'));

  await fire(page, 'w-a', 'finished');
  await expect(banners(page)).toHaveCount(1);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as any)._native.length), 'in front: no device notification').toBe(0);

  await page.evaluate(() => { (window as any)._front = false; });
  await fire(page, 'w-b', 'finished');
  await expect.poll(() => page.evaluate(() => (window as any)._native.length), { message: 'background: notified' }).toBe(1);

  // The switch off: in front notifies the device too.
  await page.evaluate(() => { (window as any)._front = true; (window as any)._notifToggleBgOnly(); });
  await fire(page, 'w-c', 'finished');
  await expect.poll(() => page.evaluate(() => (window as any)._native.length)).toBe(2);
});

test('a muted kind and the worker you are viewing raise nothing, but stay in the bell list', async ({ page }) => {
  await page.addInitScript(fakeDevice);
  await page.goto('/');
  await page.waitForFunction(() => typeof (window as any)._fireSessionNotif === 'function');
  await page.evaluate(() => { document.body.classList.remove('intent-simple'); (window as any)._front = false; });

  // "Started working" is muted by default, even in the background.
  await fire(page, 'w-a', 'started');
  // The worker open in front of you starting or stopping: you are watching it.
  await page.evaluate(() => { (window as any)._front = true; });
  await page.evaluate('peekSession = "w-view"');
  await fire(page, 'w-view', 'stopped');
  await page.waitForTimeout(400);
  await expect(banners(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any)._native.length)).toBe(0);
  const items = await page.evaluate(() => JSON.parse(localStorage.getItem('amux_notif_items') || '[]').slice(0, 2));
  expect(items.map((n: any) => [n.title, n.read])).toEqual([['w-view stopped', true], ['w-a started', true]]);

  // Another worker stopping while you view w-view still pops up.
  await fire(page, 'w-other', 'stopped');
  await expect(banners(page)).toHaveCount(1);
});

test('the page reports in front / background to the server, which holds pushes for it', async ({ page }) => {
  await page.addInitScript(fakeDevice);
  const bodies: any[] = [];
  await page.route('**/api/push/presence', async (r) => { bodies.push(r.request().postDataJSON()); await r.continue(); });
  await page.goto('/');
  await page.waitForFunction(() => typeof (window as any)._pushPresenceBeat === 'function');
  await page.evaluate(() => (window as any)._pushPresenceBeat(true));
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  expect(bodies.at(-1)).toMatchObject({ endpoint: 'https://push.example/dev1', foreground: true, background_only: true });

  await page.evaluate(() => { (window as any)._front = false; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => bodies.at(-1)?.foreground).toBe(false);

  // The real route: a fresh in-front report shows on the subscriptions probe.
  const res = await page.evaluate(async () => {
    const h = (window as any)._authHeaders({ 'Content-Type': 'application/json' });
    const post = (b: any) => fetch('/api/push/presence', { method: 'POST', headers: h, body: JSON.stringify(b) }).then(r => r.status);
    const ok = await post({ endpoint: 'https://push.example/probe', foreground: true });
    const bad = await post({});
    const subs = await (await fetch('/api/push/subscriptions', { headers: h })).json();
    return { ok, bad, presence: subs.presence };
  });
  expect(res.ok).toBe(200);
  expect(res.bad, 'no endpoint is refused').toBe(400);
  expect(res.presence.measured).toBe(true);
  expect(res.presence.in_front).toBeGreaterThanOrEqual(1);
});

// A desktop browser with amux in a background tab got "finished its goal"
// twice: once from the page, once from the server's web push. Both now carry
// the tag goal-met:<worker> (goal_keeper.rs notify_met_once), so the second
// replaces the first without a second alert.
test('a goal met already shown by the server push is replaced quietly, not repeated', async ({ page }) => {
  await page.addInitScript(fakeDevice);
  await page.addInitScript(() => {
    const w = window as any;
    w._shown = [];
    const reg = {
      showNotification: async (t: string, o: any) => { w._native.push(t); w._shown.push({ tag: o.tag, renotify: o.renotify }); },
      getNotifications: async ({ tag }: any) => w._shown.filter((n: any) => n.tag === tag),
      pushManager: { getSubscription: async () => null },
    };
    Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { configurable: true, get: () => Promise.resolve(reg) });
  });
  await page.goto('/');
  await page.evaluate(() => { (window as any)._front = false; });
  // First: nothing showing yet, so it alerts.
  await fire(page, 'w1', 'goal');
  await expect.poll(() => page.evaluate(() => (window as any)._shown)).toEqual([{ tag: 'goal-met:w1', renotify: true }]);
  // The server's push for w2 is already on screen under its tag: the page's
  // own notification replaces it with no second alert.
  await page.evaluate(() => { (window as any)._shown.push({ tag: 'goal-met:w2', renotify: true }); });
  await fire(page, 'w2', 'goal');
  await expect.poll(() => page.evaluate(() => (window as any)._shown.length)).toBe(3);
  expect(await page.evaluate(() => (window as any)._shown[2])).toEqual({ tag: 'goal-met:w2', renotify: false });
  // Other kinds keep their own per-worker tag.
  await fire(page, 'w1', 'stopped');
  await expect.poll(() => page.evaluate(() => (window as any)._shown[3]?.tag)).toBe('amux-w1');
});
