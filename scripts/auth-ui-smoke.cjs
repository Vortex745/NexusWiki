#!/usr/bin/env node
/**
 * Real-browser smoke for the local ID/password sign-in and the sidebar user
 * menu. Drives system Chrome over the DevTools protocol (no extra dependency)
 * and writes one screenshot per step into docs/evidence/auth-jwt-2026-10-28/.
 *
 * Run against an isolated backend + Vite pair. The backend must use a FRESH
 * SQLite database: this run registers 小明 and expects an empty registry.
 *   API_PORT=3101 DEMO_OIDC_PORT=3901 SQLITE_PATH=./.tmp-auth-test/auth.db npx tsx src/index.ts
 *   VITE_PORT=3100 API_PROXY_TARGET=http://127.0.0.1:3101 npx vite
 *   npm run auth:ui-smoke
 *
 * Any JS console error / uncaught exception fails the run. Expected HTTP
 * statuses (the anonymous 401 probe, the deliberate duplicate 409, and the
 * local-thread 409 after switching accounts) are reported but not fatal.
 */
const { spawn } = require("node:child_process");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE_URL = process.env.AUTH_UI_BASE_URL || "http://localhost:3100";
const OUT_DIR = resolve(process.env.AUTH_UI_OUT_DIR || "docs/evidence/auth-jwt-2026-10-28");
const PROFILE = resolve(".tmp-auth-test/chrome-profile");
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9223);
const ADMIN_ID = process.env.AUTH_UI_ADMIN_ID || "admin";
const ADMIN_PASSWORD = process.env.AUTH_UI_ADMIN_PASSWORD || process.env.DEMO_OIDC_PASSWORD || "123456";
const VIEWPORT = { width: 1280, height: 900 };

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(check, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ""}`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(resolve(".tmp-auth-test"), { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--disable-search-engine-choice-screen",
      "--disable-background-networking",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let ws;
  try {
    const version = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      return response.ok ? response.json() : null;
    }, "Chrome DevTools endpoint", 20_000);

    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((done, fail) => {
      ws.addEventListener("open", done, { once: true });
      ws.addEventListener("error", fail, { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    const consoleErrors = [];
    const networkErrors = [];
    /** Expected by design: the anonymous session probe, the deliberate duplicate registration, and the browser reusing a local thread id after an account switch. */
    const expectedNetwork = [
      /\/api\/session\b.*\b401\b/,
      /\/api\/auth\/register\b.*\b409\b/,
      /\/api\/chat\/sessions\/[^/]+\/attachments\b.*\b409\b/,
    ];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        const text = message.params.args
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(" ");
        consoleErrors.push(`console.error: ${text}`);
      }
      if (message.method === "Runtime.exceptionThrown") {
        consoleErrors.push(`exception: ${message.params.exceptionDetails.text}`);
      }
      if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
        const entry = `${message.params.entry.url ?? ""} ${message.params.entry.text}`.trim();
        networkErrors.push(entry);
      }
    });

    function send(method, params = {}, sessionId) {
      const id = ++nextId;
      return new Promise((resolvePromise, rejectPromise) => {
        pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }

    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Log.enable", {}, sessionId);
    await send(
      "Emulation.setDeviceMetricsOverride",
      { ...VIEWPORT, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );

    async function evaluate(expression) {
      const result = await send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true, userGesture: true },
        sessionId,
      );
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      }
      return result.result.value;
    }

    async function waitForExpression(expression, label, timeoutMs) {
      return waitFor(() => evaluate(expression), label, timeoutMs);
    }

    async function fill(selector, value) {
      const filled = await evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
        return true;
      })()`);
      if (!filled) throw new Error(`No input matches ${selector}`);
      await sleep(80);
    }

    async function click(selector, label) {
      const clicked = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return false;
        element.click();
        return true;
      })()`);
      if (!clicked) throw new Error(`No element matches ${selector} (${label})`);
      await sleep(300);
    }

    async function clickSegment(label) {
      const clicked = await evaluate(`(() => {
        const button = [...document.querySelectorAll("button[aria-pressed]")]
          .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)});
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (!clicked) throw new Error(`No segmented option named ${label}`);
      await sleep(300);
    }

    async function clickMenuItem(label) {
      const clicked = await evaluate(`(() => {
        const item = [...document.querySelectorAll('[role="menuitem"]')]
          .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)});
        if (!item) return false;
        item.click();
        return true;
      })()`);
      if (!clicked) throw new Error(`No menu item named ${label}`);
      await sleep(400);
    }

    async function screenshot(name) {
      const { data } = await send(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false },
        sessionId,
      );
      const path = join(OUT_DIR, name);
      writeFileSync(path, Buffer.from(data, "base64"));
      console.log(`  screenshot ${path}`);
    }

    async function signedInAs(name) {
      await waitForExpression(
        `Boolean(document.querySelector('button[aria-label="账号菜单，${name}"]'))`,
        `signed-in account menu for ${name}`,
      );
      await sleep(500);
    }

    console.log("1. login screen");
    await send("Page.navigate", { url: BASE_URL }, sessionId);
    await waitForExpression(
      `Boolean(document.querySelector('form[aria-label="登录"]'))`,
      "login form",
    );
    await sleep(500);
    await screenshot("01-login.png");

    console.log("2. register 小明");
    await clickSegment("注册");
    await waitForExpression(
      `Boolean(document.querySelector('form[aria-label="注册账号"]'))`,
      "register form",
    );
    await fill("#login-id", "小明");
    await fill("#login-password", "Pass1234");
    await sleep(300);
    await screenshot("02-register-form.png");
    await click('form button[type="submit"]', "register submit");
    await waitForExpression(
      `document.body.innerText.includes("请使用新账号的 ID 与密码登录")`,
      "registration success notice",
    );
    await waitForExpression(
      `Boolean(document.querySelector('form[aria-label="登录"]'))`,
      "login form after registration",
    );
    await sleep(400);
    await screenshot("03-register-success.png");

    console.log("3. sign in as 小明");
    await fill("#login-password", "Pass1234");
    await click('form button[type="submit"]', "sign-in submit");
    await signedInAs("小明");
    await screenshot("04-signed-in.png");

    console.log("4. open the account menu");
    await click('button[aria-label="账号菜单，小明"]', "account trigger");
    await waitForExpression(
      `Boolean(document.querySelector('[role="menuitem"]'))`,
      "account menu",
    );
    await sleep(500);
    await screenshot("05-user-menu.png");
    await clickMenuItem("退出登录");
    await waitForExpression(
      `Boolean(document.querySelector('form[aria-label="登录"]'))`,
      "login form after sign-out",
    );
    await sleep(400);
    await screenshot("06-signed-out.png");

    console.log("5. duplicate registration is refused");
    await clickSegment("注册");
    await fill("#login-id", "小明");
    await fill("#login-password", "Pass1234");
    await click('form button[type="submit"]', "duplicate register submit");
    await waitForExpression(
      `document.body.innerText.includes("这个 ID 已被注册")`,
      "duplicate ID error",
    );
    await sleep(400);
    await screenshot("07-duplicate-id.png");

    console.log("6. administrator signs in with the special ID");
    await clickSegment("登录");
    await fill("#login-id", ADMIN_ID);
    await fill("#login-password", ADMIN_PASSWORD);
    await click('form button[type="submit"]', "admin sign-in submit");
    await signedInAs(ADMIN_ID);
    await click(`button[aria-label="账号菜单，${ADMIN_ID}"]`, "admin account trigger");
    await waitForExpression(
      `document.body.innerText.includes("管理员")`,
      "admin caption",
    );
    await sleep(500);
    await screenshot("08-admin-menu.png");
    await clickMenuItem("退出登录");
    await waitForExpression(
      `Boolean(document.querySelector('form[aria-label="登录"]'))`,
      "login form after admin sign-out",
    );
    await screenshot("09-final-login.png");

    if (consoleErrors.length > 0) {
      console.error("Browser console errors:");
      for (const error of consoleErrors) console.error(`  - ${error}`);
      throw new Error(`${consoleErrors.length} browser console error(s)`);
    }
    const unexpectedNetwork = networkErrors.filter(
      (entry) => !expectedNetwork.some((pattern) => pattern.test(entry)),
    );
    if (unexpectedNetwork.length > 0) {
      console.error("Unexpected failed requests:");
      for (const error of unexpectedNetwork) console.error(`  - ${error}`);
      throw new Error(`${unexpectedNetwork.length} unexpected failed request(s)`);
    }
    for (const entry of networkErrors) console.log(`  expected failed request: ${entry}`);
    console.log("PASS: registration, sign-in, user menu, sign-out, duplicate guard and admin sign-in");
    console.log("PASS: no JS console errors, uncaught exceptions, or unexpected failed requests");
  } finally {
    try {
      ws?.close();
    } catch {}
    chrome.kill();
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
