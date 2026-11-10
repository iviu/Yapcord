/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, ipcMain, session } from "electron";
import { join } from "path";
const MI_PREFIX = "MultiInstance";
const cachePath = () => join(app.getPath("userData"), "MultiInstance", "token-cache.json");
let sharedTokenCache: Record<string, string> = {};
let sharedAccounts: any[] = [];

async function readJson<T>(p: string, fallback: T): Promise<T> {
    try {
        const fs = await import("fs/promises");
        return JSON.parse(await fs.readFile(p, "utf8"));
    } catch { return fallback; }
}
async function writeJson(p: string, data: unknown) {
    try {
        const fs = await import("fs/promises");
        await fs.mkdir(join(app.getPath("userData"), "MultiInstance"), { recursive: true });
        await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
    } catch {}
}

const PREFIX = "dQw4w9WgXcQ:";
export async function encryptToken(token: string): Promise<string> {
    if (!token) return token;
    return PREFIX + Buffer.from(token, "utf8").toString("base64");
}
export async function decryptToken(token: string): Promise<string> {
    if (!token?.startsWith(PREFIX)) return token;
    try { return Buffer.from(token.slice(PREFIX.length), "base64").toString("utf8"); }
    catch { return ""; }
}

const instanceWindows = new Map<string, BrowserWindow>();
function buildUrl(domain: string) {
    return `https://${domain}/channels/@me`;
}

async function openWindow(opts: {
    token: string; userId: string; username: string; domain: string;
    detached: boolean; grouped: boolean;
    blockExternalTokenAccess: boolean; performanceMode: boolean;
    audioSettings?: any;
}) {
    if (!opts.token || !opts.userId) return { ok: false, error: "missing token/userId" };
    if (instanceWindows.has(opts.userId) && !instanceWindows.get(opts.userId)!.isDestroyed()) {
        instanceWindows.get(opts.userId)!.focus();
        return { ok: true };
    }

    const partition = `persist:mi-${opts.userId}`;
    const ses = session.fromPartition(partition);
    ses.clearStorageData().catch(() => {});
    const win = new BrowserWindow({
        width: opts.grouped ? 1024 : 1280,
        height: 800,
        title: `Discord — ${opts.username}`,
        webPreferences: {
            partition,
            preload: join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    await win.webContents.executeJavaScript(`
        (() => {
            const t = ${JSON.stringify(opts.token)};
            window.__nightcord_token = t;
            window.__nightcord_user_id = ${JSON.stringify(opts.userId)};
            try {
                localStorage.setItem("token", JSON.stringify(t));
                localStorage.setItem("default_token", JSON.stringify(t));
                localStorage.setItem("user_id_cache", JSON.stringify(${JSON.stringify(opts.userId)}));
            } catch {}
        })();
    `).catch(() => {});
    win.loadURL(buildUrl(opts.domain));
    instanceWindows.set(opts.userId, win);
    win.on("closed", () => {
        instanceWindows.delete(opts.userId);
    });

    return { ok: true };
}

export async function getOpenInstances(): Promise<string[]> {
    return Array.from(instanceWindows.keys()).filter(id => {
        const w = instanceWindows.get(id);
        return w && !w.isDestroyed();
    });
}

export async function closeInstance(userId: string): Promise<void> {
    const w = instanceWindows.get(userId);
    if (w && !w.isDestroyed()) w.close();
    instanceWindows.delete(userId);
}

const audioPath = () => join(app.getPath("userData"), "MultiInstance", "master-audio.json");
export async function saveMasterAudioSettings(data: any): Promise<void> {
    await writeJson(audioPath(), data);
}
export async function getMasterAudioSettings(): Promise<any> {
    return readJson(audioPath(), null);
}

export async function getSharedTokenCache(): Promise<Record<string, string>> {
    return sharedTokenCache;
}
export async function saveSharedTokenCache(data: Record<string, string>): Promise<void> {
    sharedTokenCache = data;
    await writeJson(cachePath(), data);
}
export async function getSharedAccounts(): Promise<any[]> {
    return sharedAccounts;
}
export async function saveSharedAccounts(data: any[]): Promise<void> {
    sharedAccounts = data;
    await writeJson(join(app.getPath("userData"), "MultiInstance", "accounts.json"), data);
}

export async function getInstanceAuth(): Promise<{ token: string; userId: string; username: string } | null> {
    return null;
}

export function registerMultiInstanceNative() {
    const fns: Record<string, (...args: any[]) => any> = {
        encryptToken: (_e: any, token: string) => encryptToken(token),
        decryptToken: (_e: any, token: string) => decryptToken(token),
        getOpenInstances: () => getOpenInstances(),
        closeInstance: (_e: any, id: string) => closeInstance(id),
        saveMasterAudioSettings: (_e: any, d: any) => saveMasterAudioSettings(d),
        getMasterAudioSettings: () => getMasterAudioSettings(),
        getSharedTokenCache: () => getSharedTokenCache(),
        saveSharedTokenCache: (_e: any, d: any) => saveSharedTokenCache(d),
        getSharedAccounts: () => getSharedAccounts(),
        saveSharedAccounts: (_e: any, d: any) => saveSharedAccounts(d),
        getInstanceAuth: () => getInstanceAuth(),
        openInstanceWindow: async (_e: any, token: string, userId: string, detached: boolean, username: string, domain: string, block: boolean, perf: boolean, audio: any) =>
            openWindow({ token, userId, username, domain, detached, grouped: false, blockExternalTokenAccess: block, performanceMode: perf, audioSettings: audio }),
        openInstanceWindowGrouped: async (_e: any, token: string, userId: string, username: string, domain: string, block: boolean, perf: boolean, audio: any) =>
            openWindow({ token, userId, username, domain, detached: false, grouped: true, blockExternalTokenAccess: block, performanceMode: perf, audioSettings: audio }),
    };
    for (const [name, fn] of Object.entries(fns)) {
        ipcMain.handle(`${MI_PREFIX}.${name}`, fn);
    }
}
