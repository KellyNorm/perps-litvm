import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { JSDOM } from "jsdom";

// The clear-chat button, driven through the real component tree.
//
// WHY THIS ONE TEST HAS A DOM, when every other suite in test/ deliberately does not:
// the bug it guards lived in neither half on its own. `useTachyChat.reset` was correct
// and the button was wired to it correctly — but the panel rendered that button
// `disabled={pending}`, so for the 1-3s a real reply takes, clicking it did nothing. The
// defect only exists in the join between the hook and the view, mid-request, so only a
// mounted tree with a request held open can catch it. Asserting on the hook or on static
// markup would have passed throughout.
//
// The gate is gone for good reason and must stay gone: `askTachy` has no timeout, so a
// request that never resolves used to leave `pending` true forever and the button dead
// permanently, with a page reload the only way out. Clearing is the one control a user
// needs most precisely when a request is misbehaving.
//
// Safe to clear mid-flight because `reset` bumps a generation counter and the in-flight
// send drops its own reply on the way back — the third assertion below is what holds
// that guard in place.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Imported after the DOM globals exist: react-dom binds to them on first render.
const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: TachyLauncher } = await import("../../src/components/tachy/TachyLauncher.jsx");

const ANSWER = "Leverage is borrowed size.";

// Every fetch is held open until the test decides to answer it. This is the whole point:
// a stub that resolves immediately has no in-flight window to clear during.
let openRequests = [];
globalThis.fetch = () =>
  new Promise((resolve) => {
    openRequests.push(() =>
      resolve({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          reply: { explanation: ANSWER, clarificationQuestion: null, language: "en", knowsAnswer: true },
          meta: { fallback: false, reason: null },
        }),
      }),
    );
  });

// Lets the newest held request land.
const answerNewest = () => openRequests.pop()();

const q = (sel) => document.querySelector(sel);
const all = (sel) => [...document.querySelectorAll(sel)];

// A real bubbled click, not a direct handler call, so `disabled` is honoured the way the
// browser honours it — a disabled button swallows the event. That is exactly the failure
// being guarded against, and calling onClick directly would sail straight past it.
const click = (el) => act(async () => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

// Counts turns in the thread. The thinking bubble carries `.tachy-msg` too, so this is
// only read at points where the test has established whether one is up.
const turns = () => all(".tachy-msg").length;

async function mountOpenPanel(t) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  // Unmount rather than leave it: EyesMascot's blink timer reschedules itself forever and
  // would hold the event loop open, hanging `npm test` long after the assertions pass.
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    openRequests = [];
  });

  await act(async () => root.render(React.createElement(TachyLauncher, { view: "perps" })));
  await click(q(".tachy-fab"));
  return root;
}

describe("clear-chat button", () => {
  test("appears only once there is a thread to clear", async (t) => {
    await mountOpenPanel(t);
    assert.equal(q(".tachy-clear"), null, "nothing to clear on an empty thread");

    await click(q(".tachy-chip"));
    await settle();
    assert.ok(q(".tachy-clear"), "must appear as soon as the thread has a message");
  });

  test("clears DURING an in-flight request, drops the orphaned reply, and stays usable", async (t) => {
    await mountOpenPanel(t);

    // Ask via a starter chip and leave the reply hanging.
    await click(q(".tachy-chip"));
    await settle();
    assert.ok(q(".tachy-thinking"), "precondition: a request is genuinely in flight");

    const clear = q(".tachy-clear");
    assert.ok(clear, "the button must be reachable mid-request, not only once idle");
    assert.equal(clear.disabled, false, "must not be gated on `pending` — this is the regression");

    // 1. Clearing works mid-flight.
    await click(clear);
    await settle();
    assert.equal(turns(), 0, "the thread must be empty, including the thinking bubble");
    assert.ok(q(".tachy-greeting"), "the greeting must come back");
    assert.equal(all(".tachy-chip").length, 3, "and so must the FAQ chips");
    assert.equal(q(".tachy-clear"), null, "the button retires with the thread it cleared");
    assert.equal(document.activeElement, q(".tachy-input"), "focus lands in the input, not on <body>");

    // 2. The abandoned reply now arrives. It belongs to a conversation the user threw
    //    away, so the generation guard must drop it instead of appending it to the fresh
    //    thread — otherwise the answer materialises under the greeting with no question.
    answerNewest();
    await settle();
    assert.equal(turns(), 0, "a late reply must not resurrect the cleared thread");
    assert.ok(q(".tachy-greeting"), "the greeting must survive the late reply");

    // 3. The panel is immediately usable again: `reset` released both the in-flight latch
    //    and `pending`, so a fresh question goes through rather than being swallowed.
    assert.equal(q(".tachy-input").disabled, false, "composer must be live again");
    await click(q(".tachy-chip"));
    await settle();
    answerNewest();
    await settle();
    assert.equal(turns(), 2, "a fresh send after clearing must produce question + answer");
    assert.match(q(".tachy-msg-tachy .tachy-bubble").textContent, /borrowed size/);
  });
});
