/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";
import { addHeaderBarButton, removeHeaderBarButton } from "@api/HeaderBar";
import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { Modals, openModal } from "@utils/modal";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByProps, waitFor } from "@webpack";
import { FluxDispatcher, Forms, IconUtils, MediaEngineStore, React, ReactDOM, UserStore } from "@webpack/common";
const ModalRoot = (Modals as any).ModalRoot as React.FC<any>;
const ModalHeader = (Modals as any).ModalHeader as React.FC<any>;
const ModalContent = (Modals as any).ModalContent as React.FC<any>;
const ModalCloseButton = (Modals as any).ModalCloseButton as React.FC<any>;
const t = (text: string) => text;
const AUTHORS = [{ name: "Yapcord", id: 0n }] as const;
const settings = definePluginSettings({
    domain: {
        type: OptionType.SELECT,
        description: "Discord release channel / domain to open for instances.",
        options: [
            { label: "Discord (Stable)", value: "discord.com", default: true },
            { label: "Discord PTB", value: "ptb.discord.com" },
            { label: "Discord Canary", value: "canary.discord.com" },
        ],
    },
    syncAudioSettings: {
        type: OptionType.BOOLEAN,
        description: "Audio Settings Sync: Automatically inherit audio devices, volume, and Krisp from your main Discord window.",
        default: true,
    },
    blockExternalTokenAccess: {
        type: OptionType.BOOLEAN,
        description: "Token Protection: Use protected temporary sessions and clear saved login data before opening an instance.",
        default: false,
    },
    performanceMode: {
        type: OptionType.BOOLEAN,
        description: "Performance Mode: Throttle background instances to reduce CPU usage.",
        default: false,
    },
});

const Native = (
    (globalThis as any).VencordNative?.pluginHelpers?.MultiInstance ?? {}
) as PluginNative<Record<string, (...args: any[]) => any>>;

const STORE_KEY = "TokenImporter_accounts";
const MI_TOKEN_CACHE_KEY = "nightcord-mi-token-cache";
let tokenCache: Record<string, string> = {};
let tokenCacheLoaded = false;
let encryptHooked = false;

async function loadTokenCache(): Promise<void> {
    if (tokenCacheLoaded) return;
    let local: Record<string, string> = {};
    try {
        local = (await DataStore.get<Record<string, string>>(MI_TOKEN_CACHE_KEY)) ?? {};
    } catch {}

    let shared: Record<string, string> = {};
    try {
        if (typeof Native?.getSharedTokenCache === "function") {
            shared = (await Native.getSharedTokenCache()) ?? {};
        }
    } catch {}
    tokenCache = { ...shared, ...local, ...tokenCache };
    tokenCacheLoaded = true;
    const curUser = UserStore.getCurrentUser();
    const tokenMod = findByProps("getToken", "encryptAndStoreTokens");
    const curTok = tokenMod?.getToken?.();
    if (curUser?.id && curTok) {
        tokenCache[curUser.id] = curTok;
    }
    let dirty = false;
    for (const [id, tok] of Object.entries(tokenCache)) {
        if (!tok || typeof tok !== "string") {
            delete tokenCache[id];
            dirty = true;
            continue;
        }
        let realTok = tok;
        if (tok.startsWith("dQw4w9WgXcQ:")) {
            try {
                const dec = await Native.decryptToken(tok);
                if (dec && !dec.startsWith("dQw4w9WgXcQ:")) {
                    tokenCache[id] = dec;
                    realTok = dec;
                    dirty = true;
                }
            } catch { }
        }
        if (curUser?.id && curTok && id !== curUser.id && realTok === curTok) {
            delete tokenCache[id];
            dirty = true;
            continue;
        }
        const owner = getUserIdFromToken(realTok);
        if (owner && owner !== id) {
            delete tokenCache[id];
            dirty = true;
        }
    }
    if (dirty || Object.keys(tokenCache).length > Object.keys(local).length) {
        saveTokenCache();
    }
}

let _saveTokenTimer: ReturnType<typeof setTimeout> | undefined;
function saveTokenCache(): void {
    if (_saveTokenTimer !== undefined) clearTimeout(_saveTokenTimer);
    _saveTokenTimer = setTimeout(() => {
        _saveTokenTimer = undefined;
        DataStore.set(MI_TOKEN_CACHE_KEY, tokenCache).catch(() => {});
        if (typeof Native?.saveSharedTokenCache === "function") {
            Native.saveSharedTokenCache(tokenCache).catch(() => {});
        }
    }, 1000);
}

function decodeBase64Safe(str: string): string | null {
    try {
        let normalized = str.replace(/-/g, "+").replace(/_/g, "/");
        while (normalized.length % 4 !== 0) normalized += "=";
        return atob(normalized);
    } catch {
        return null;
    }
}

function getUserIdFromToken(token: string): string | null {
    if (!token || typeof token !== "string") return null;
    try {
        const parts = token.split(".");
        if (parts.length < 2) return null;
        const decoded = decodeBase64Safe(parts[0]);
        if (decoded && /^\d{17,20}$/.test(decoded)) return decoded;
    } catch {}
    return null;
}

function cacheToken(userId: string, token: string): boolean {
    if (!userId || !token || typeof token !== "string") return false;
    const cleanTok = token.trim().replace(/^"+|"+$/g, "");
    const tokenOwner = getUserIdFromToken(cleanTok);
    if (tokenOwner && tokenOwner !== userId) {
        console.warn(`[MultiInstance] Token owner mismatch: belongs to ${tokenOwner}, expected ${userId}. Cache rejected.`);
        return false;
    }
    if (tokenCache[userId] === cleanTok) return false;
    tokenCache[userId] = cleanTok;
    return true;
}

function captureCurrentToken(): void {
    try {
        const tokenMod = findByProps("getToken", "encryptAndStoreTokens");
        const token = tokenMod?.getToken?.();
        const user = UserStore.getCurrentUser();
        if (token && user?.id && typeof token === "string") {
            const changed = cacheToken(user.id, token);
            if (changed) saveTokenCache();
            if (typeof fetchAllAccounts === "function") {
                fetchAllAccounts().catch(() => {});
            }
        }
    } catch { }
}

function hookEncryptAndStoreTokens(): void {
    if (encryptHooked) return;
    try {
        const tokenMod = findByProps("getToken", "encryptAndStoreTokens");
        if (!tokenMod?.encryptAndStoreTokens) return;
        const orig = tokenMod.encryptAndStoreTokens.bind(tokenMod);
        tokenMod.encryptAndStoreTokens = async function (tokens: Record<string, string>) {
            if (tokens && typeof tokens === "object") {
                let changed = false;
                for (const [id, token] of Object.entries(tokens)) {
                    if (id && token && cacheToken(id, token)) changed = true;
                }
                if (changed) saveTokenCache();
            }
            return orig(tokens);
        };
        encryptHooked = true;
    } catch { }
}

function hookFluxDispatcher(): (() => void) | null {
    try {
        if (!FluxDispatcher?.subscribe) return null;
        const handler = (event: any) => {
            if (event?.token && event?.userId) {
                const changed = cacheToken(event.userId, event.token);
                if (changed) saveTokenCache();
            }
        };
        FluxDispatcher.subscribe("MULTI_ACCOUNT_VALIDATE_TOKEN_SUCCESS", handler);
        return () => FluxDispatcher.unsubscribe("MULTI_ACCOUNT_VALIDATE_TOKEN_SUCCESS", handler);
    } catch { return null; }
}

function isCurrentInstanceWindow(): boolean {
    return !!((window as any).__nightcord_token || (window as any).__nightcord_user_id);
}

function captureMasterAudioSettings(): Record<string, any> | null {
    try {
        const rawLs = window.localStorage.getItem("MediaEngineStore");
        let parsedLs: any = null;
        if (rawLs) { try { parsedLs = JSON.parse(rawLs); } catch {} }

        let storeSettings: any = null;
        try {
            if (MediaEngineStore) {
                const rawNoiseSuppression = MediaEngineStore.getNoiseSuppression?.();
                const rawState = (MediaEngineStore.getState?.()?.settingsByContext?.default ?? {}) as any;
                storeSettings = {
                    ...rawState,
                    noiseSuppression2: rawState.noiseSuppression2 ?? rawState.noiseSuppressionType ?? undefined,
                    noiseCancellation: MediaEngineStore.getNoiseCancellation?.(),
                    noiseSuppression: rawNoiseSuppression,
                    echoCancellation: MediaEngineStore.getEchoCancellation?.(),
                    automaticGainControl: MediaEngineStore.getAutomaticGainControl?.(),
                    inputVolume: MediaEngineStore.getInputVolume?.(),
                    outputVolume: MediaEngineStore.getOutputVolume?.(),
                    inputDeviceId: MediaEngineStore.getInputDeviceId?.(),
                    outputDeviceId: MediaEngineStore.getOutputDeviceId?.(),
                    mode: MediaEngineStore.getMode?.(),
                    modeOptions: MediaEngineStore.getModeOptions?.(),
                    attenuation: MediaEngineStore.getAttenuation?.(),
                    attenuateWhileSpeakingSelf: MediaEngineStore.getAttenuateWhileSpeakingSelf?.(),
                    attenuateWhileSpeakingOthers: MediaEngineStore.getAttenuateWhileSpeakingOthers?.(),
                    qos: MediaEngineStore.getQoS?.(),
                };
            }
        } catch {}

        const defaultSettings = { ...(parsedLs?.default || {}), ...(storeSettings || {}) };
        const mergedFullState = {
            ...(parsedLs || {}),
            default: { ...(parsedLs?.default || {}), ...(storeSettings || {}) },
        };
        return {
            rawMediaEngineStore: JSON.stringify(mergedFullState),
            defaultSettings,
            fullState: mergedFullState,
        };
    } catch {
        return null;
    }
}

let _audioSaveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleMasterAudioSave(): void {
    if (isCurrentInstanceWindow()) return;
    if (_audioSaveTimer !== undefined) clearTimeout(_audioSaveTimer);
    _audioSaveTimer = setTimeout(() => {
        _audioSaveTimer = undefined;
        const audio = captureMasterAudioSettings();
        if (audio && typeof Native?.saveMasterAudioSettings === "function") {
            Native.saveMasterAudioSettings(audio).catch(() => {});
        }
    }, 500);
}

function applyAudioSettings(audio: any): void {
    if (!audio) return;
    const def = audio.defaultSettings || audio;
    if (!def || typeof def !== "object") return;

    if (typeof def.outputVolume === "number") {
        try { FluxDispatcher?.dispatch?.({ type: "AUDIO_SET_OUTPUT_VOLUME", volume: def.outputVolume }); } catch {}
    }
    if (typeof def.inputVolume === "number") {
        try { FluxDispatcher?.dispatch?.({ type: "AUDIO_SET_INPUT_VOLUME", volume: def.inputVolume }); } catch {}
    }
    if (def.outputDeviceId && typeof def.outputDeviceId === "string") {
        try { FluxDispatcher?.dispatch?.({ type: "AUDIO_SET_OUTPUT_DEVICE", id: def.outputDeviceId }); } catch {}
    }
    if (def.inputDeviceId && typeof def.inputDeviceId === "string") {
        try { FluxDispatcher?.dispatch?.({ type: "AUDIO_SET_INPUT_DEVICE", id: def.inputDeviceId }); } catch {}
    }

    const meActions = findByProps("setNoiseCancellation", "setNoiseSuppression") || findByProps("setNoiseCancellation");
    if (typeof def.noiseCancellation === "boolean") {
        try { meActions?.setNoiseCancellation?.(def.noiseCancellation); } catch {}
        try { (MediaEngineStore?.getMediaEngine?.() as any)?.setNoiseCancellation?.(def.noiseCancellation); } catch {}
    }
    if (def.noiseSuppression !== undefined && def.noiseSuppression !== null) {
        try { meActions?.setNoiseSuppression?.(def.noiseSuppression); } catch {}
        try { (MediaEngineStore?.getMediaEngine?.() as any)?.setNoiseSuppression?.(def.noiseSuppression); } catch {}
    }
    if (typeof def.echoCancellation === "boolean") {
        try { meActions?.setEchoCancellation?.(def.echoCancellation); } catch {}
        try { (MediaEngineStore?.getMediaEngine?.() as any)?.setEchoCancellation?.(def.echoCancellation); } catch {}
    }
    if (typeof def.automaticGainControl === "boolean") {
        try { meActions?.setAutomaticGainControl?.(def.automaticGainControl); } catch {}
        try { (MediaEngineStore?.getMediaEngine?.() as any)?.setAutomaticGainControl?.(def.automaticGainControl); } catch {}
    }
    if (def.mode) {
        try {
            const modeActions = findByProps("setMode") || meActions;
            modeActions?.setMode?.(def.mode, def.modeOptions ?? {});
        } catch {}
    }
    if (typeof def.attenuation === "number") {
        try {
            const attActions = findByProps("setAttenuation") || meActions;
            attActions?.setAttenuation?.(
                def.attenuation,
                Boolean(def.attenuateWhileSpeakingSelf),
                Boolean(def.attenuateWhileSpeakingOthers)
            );
        } catch {}
    }
    if (typeof def.qos === "boolean") {
        try { meActions?.setQoS?.(def.qos); } catch {}
    }

    try {
        if (MediaEngineStore) {
            const state = MediaEngineStore.getState?.();
            if (state?.settingsByContext?.default) {
                Object.assign(state.settingsByContext.default, def);
                MediaEngineStore.emitChange?.();
            }
        }
    } catch {}

    if (audio.rawMediaEngineStore && typeof audio.rawMediaEngineStore === "string") {
        try { window.localStorage.setItem("MediaEngineStore", audio.rawMediaEngineStore); } catch {}
    }
}

async function syncInstanceAudioSettings(): Promise<void> {
    try {
        if (typeof Native?.getMasterAudioSettings !== "function") return;
        const masterAudio = await Native.getMasterAudioSettings();
        if (!masterAudio) return;

        if (masterAudio.rawMediaEngineStore && typeof masterAudio.rawMediaEngineStore === "string") {
            try { window.localStorage.setItem("MediaEngineStore", masterAudio.rawMediaEngineStore); } catch {}
        }

        const tryApply = () => applyAudioSettings(masterAudio);
        tryApply();

        waitFor(["dispatch", "subscribe"], (dispatcher: any) => {
            const unConn = dispatcher.subscribe("CONNECTION_OPEN", () => {
                try { unConn(); } catch {}
                setTimeout(tryApply, 500);
                setTimeout(tryApply, 1500);
            });
        });
        [1000, 2500, 5000].forEach(delay => setTimeout(tryApply, delay));
    } catch (e) {
        console.warn("[NightcordMI] syncInstanceAudioSettings error:", e);
    }
}

let unhookAudioWatcher: (() => void) | null = null;
function hookAudioSettingsWatcher(): void {
    if (unhookAudioWatcher) return;
    const unsubs: Array<() => void> = [];
    const onAudioChanged = () => scheduleMasterAudioSave();

    if (FluxDispatcher?.subscribe) {
        const events = [
            "AUDIO_SET_OUTPUT_VOLUME", "AUDIO_SET_INPUT_VOLUME",
            "AUDIO_SET_OUTPUT_DEVICE", "AUDIO_SET_INPUT_DEVICE",
            "AUDIO_SET_MODE", "AUDIO_SET_NOISE_SUPPRESSION",
            "AUDIO_SET_NOISE_CANCELLATION", "AUDIO_SET_ECHO_CANCELLATION",
            "AUDIO_SET_AUTOMATIC_GAIN_CONTROL", "AUDIO_SET_QOS",
            "AUDIO_SET_ATTENUATION", "MEDIA_ENGINE_SET_AUDIO_SUB_SYSTEM",
            "MEDIA_ENGINE_SETTINGS_CHANGED",
        ];
        for (const evt of events) {
            try {
                FluxDispatcher.subscribe(evt, onAudioChanged);
                unsubs.push(() => FluxDispatcher.unsubscribe(evt, onAudioChanged));
            } catch {}
        }
    }

    if (MediaEngineStore?.addChangeListener) {
        try {
            MediaEngineStore.addChangeListener(onAudioChanged);
            unsubs.push(() => MediaEngineStore.removeChangeListener(onAudioChanged));
        } catch {}
    }

    unhookAudioWatcher = () => {
        for (const u of unsubs) { try { u(); } catch {} }
        unsubs.length = 0;
        unhookAudioWatcher = null;
    };
}

interface SavedAccount { id: string; token: string; username: string; avatar: string; }
interface AccountEntry extends SavedAccount { hasToken: boolean; isNative: boolean; }
function getAvatarUrl(id: string, hash?: string | null): string {
    return hash
        ? IconUtils.getUserAvatarURL({ id, avatar: hash } as any, false, 64)
        : IconUtils.getDefaultAvatarURL(id);
}

function getNativeAccounts(): SavedAccount[] {
    try {
        const store = findByProps("getUsers", "getValidUsers");
        const users: any[] = store?.getUsers?.() ?? store?.getValidUsers?.() ?? [];
        return users.filter(u => u?.id).map(u => ({
            id: u.id,
            token: tokenCache[u.id] ?? "",
            username: u.globalName || u.username || `User_${u.id.slice(-4)}`,
            avatar: getAvatarUrl(u.id, u.avatar),
        }));
    } catch { return []; }
}

async function fetchAllAccounts(): Promise<SavedAccount[]> {
    let local: SavedAccount[] = [];
    try { local = (await DataStore.get<SavedAccount[]>(STORE_KEY)) ?? []; } catch {}

    let shared: SavedAccount[] = [];
    try {
        if (typeof (Native as any)?.getSharedAccounts === "function") {
            shared = (await (Native as any).getSharedAccounts()) ?? [];
        }
    } catch {}

    const map = new Map<string, SavedAccount>();
    for (const a of shared) if (a?.id) map.set(a.id, a);
    for (const a of local) {
        if (!a?.id) continue;
        const prev = map.get(a.id);
        map.set(a.id, {
            id: a.id,
            username: a.username || prev?.username || "",
            avatar: a.avatar || prev?.avatar || "",
            token: a.token || prev?.token || "",
        });
    }

    for (const a of getNativeAccounts()) {
        if (!a?.id) continue;
        const prev = map.get(a.id);
        map.set(a.id, {
            id: a.id,
            username: a.username || prev?.username || "",
            avatar: a.avatar || prev?.avatar || "",
            token: a.token || prev?.token || tokenCache[a.id] || "",
        });
    }

    const curUser = UserStore.getCurrentUser();
    if (curUser?.id) {
        const tokenMod = findByProps("getToken", "encryptAndStoreTokens");
        const curTok = tokenMod?.getToken?.();
        const prev = map.get(curUser.id);
        map.set(curUser.id, {
            id: curUser.id,
            username: (curUser as any).globalName || curUser.username || prev?.username || "",
            avatar: getAvatarUrl(curUser.id, curUser.avatar) || prev?.avatar || "",
            token: curTok || prev?.token || tokenCache[curUser.id] || "",
        });
    }

    const merged = Array.from(map.values());
    for (const acc of merged) {
        if (acc.token?.startsWith("dQw4w9WgXcQ:")) {
            try {
                const dec = await Native.decryptToken(acc.token);
                if (dec) acc.token = dec;
            } catch {}
        }
    }

    if (typeof (Native as any)?.saveSharedAccounts === "function") {
        (Native as any).saveSharedAccounts(merged).catch(() => {});
    }
    DataStore.set(STORE_KEY, merged).catch(() => {});
    return merged;
}

function switchToQuick(token: string, userId?: string) {
    const cleanTok = token.trim().replace(/^"+|"+$/g, "");
    try {
        window.localStorage.setItem("token", `"${cleanTok}"`);
        window.localStorage.setItem("default_token", `"${cleanTok}"`);
        if (userId) window.localStorage.setItem("user_id_cache", `"${userId}"`);
        location.reload();
    } catch {
        const iframe = document.createElement("iframe");
        iframe.style.display = "none";
        document.body.appendChild(iframe);
        try {
            (iframe as any).contentWindow.localStorage.token = `"${cleanTok}"`;
            (iframe as any).contentWindow.localStorage.default_token = `"${cleanTok}"`;
            if (userId) (iframe as any).contentWindow.localStorage.user_id_cache = `"${userId}"`;
        } catch {}
        document.body.removeChild(iframe);
        location.reload();
    }
}

function switchNativeAccount(userId: string) {
    try {
        const multiAuth = findByProps("switchAccount", "loginToken") ?? findByProps("switchAccount");
        if (multiAuth?.switchAccount) { multiAuth.switchAccount(userId); return; }
        if (FluxDispatcher?.dispatch) {
            FluxDispatcher.dispatch({ type: "MULTI_ACCOUNT_SWITCH_ATTEMPT", userId });
        }
    } catch {
        console.warn("[MultiInstance] switchNativeAccount failed for", userId);
    }
}

interface CtxState { x: number; y: number; acc: AccountEntry; }
interface CtxMenuProps extends CtxState {
    isOpen: boolean;
    onClose(): void;
    onNewWindow(): void;
    onNewDetached(): void;
    onNewGrouped(): void;
    onSwitch(): void;
}

function ContextMenuPortal(props: CtxMenuProps) {
    const { x, y, acc, isOpen, onClose, onNewWindow, onNewDetached, onNewGrouped, onSwitch } = props;
    const ref = React.useRef<HTMLDivElement>(null);
    const [pos, setPos] = React.useState({ left: x, top: y });
    const [container] = React.useState(() => {
        const el = document.getElementById("nightcord-mi-ctx-root") ?? document.createElement("div");
        el.id = "nightcord-mi-ctx-root";
        if (!el.parentNode) document.body.appendChild(el);
        return el;
    });

    React.useEffect(() => () => { try { container.remove(); } catch {} }, [container]);

    React.useEffect(() => {
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("mousedown", onDown, true);
            document.removeEventListener("keydown", onKey, true);
        };
    }, [onClose]);

    React.useLayoutEffect(() => {
        if (!ref.current) return;
        const rect = ref.current.getBoundingClientRect();
        setPos({
            left: Math.min(x, window.innerWidth - rect.width - 8),
            top: Math.min(y, window.innerHeight - rect.height - 8),
        });
    }, [x, y]);

    const menu = (
        <div ref={ref} className="mi-ctx-menu" style={{ left: pos.left, top: pos.top, position: "fixed" }}>
            <div className="mi-ctx-header">
                <span className="mi-ctx-username">{acc.username}</span>
            </div>
            <div className="mi-ctx-separator" />
            {acc.hasToken ? (
                <>
                    <div className="mi-ctx-item" onClick={() => { onNewWindow(); onClose(); }}>
                        <WindowIcon /> {t("New detached instance")}
                    </div>
                    <div className="mi-ctx-item" onClick={() => { onNewGrouped(); onClose(); }}>
                        <GroupedIcon /> {t("New grouped instance")}
                    </div>
                    <div className="mi-ctx-separator" />
                </>
            ) : (
                <div className="mi-ctx-hint">
                    {t("Switch to this account once to capture its session token.")}
                </div>
            )}
            {acc.id !== UserStore.getCurrentUser()?.id ? (
                <div className="mi-ctx-item" onClick={() => { onSwitch(); onClose(); }}>
                    <SwitchIcon /> {t("Quick switch")}
                </div>
            ) : (
                <div className="mi-ctx-hint" style={{ textAlign: "center", color: "var(--brand-500, #5865f2)", fontWeight: 600 }}>
                    {t("Current active account")}
                </div>
            )}
            {isOpen && <>
                <div className="mi-ctx-separator" />
                <div className="mi-ctx-item mi-ctx-item-danger" onClick={async () => {
                    await Native.closeInstance(acc.id).catch(() => {});
                    onClose();
                }}>
                    <CloseIcon /> {t("Close instance")}
                </div>
            </>}
        </div>
    );
    return ReactDOM.createPortal(menu, container) as any;
}

function MultiInstanceModal({ rootProps }: { rootProps: any; }) {
    const currentUser = UserStore.getCurrentUser();
    const [savedAccounts, setSavedAccounts] = React.useState<SavedAccount[]>([]);
    const [nativeAccounts, setNativeAccounts] = React.useState<SavedAccount[]>([]);
    const [openInstances, setOpenInstances] = React.useState<string[]>([]);
    const [ctx, setCtx] = React.useState<CtxState | null>(null);
    const [status, setStatus] = React.useState<string | null>(null);

    React.useEffect(() => {
        captureCurrentToken();
        fetchAllAccounts().then(setSavedAccounts).catch(() => {});
        setNativeAccounts(getNativeAccounts());
        Native.getOpenInstances().then(ids => setOpenInstances(ids ?? [])).catch(() => {});
    }, []);

    const allAccounts = React.useMemo<AccountEntry[]>(() => {
        const seen = new Set<string>();
        const result: AccountEntry[] = [];
        const tokenMod = findByProps("getToken", "encryptAndStoreTokens");
        const curTok = tokenMod?.getToken?.();

        if (currentUser) {
            seen.add(currentUser.id);
            const saved = savedAccounts.find(s => s.id === currentUser.id);
            const native = nativeAccounts.find(n => n.id === currentUser.id);
            let token = curTok || saved?.token || native?.token || tokenCache[currentUser.id] || "";
            if (token) {
                const owner = getUserIdFromToken(token);
                if (owner && owner !== currentUser.id) token = "";
            }
            result.push({
                id: currentUser.id,
                username: (currentUser as any).globalName || currentUser.username,
                avatar: getAvatarUrl(currentUser.id, currentUser.avatar),
                token,
                hasToken: !!token,
                isNative: true,
            });
        }

        for (const acc of nativeAccounts) {
            if (seen.has(acc.id)) continue;
            seen.add(acc.id);
            const saved = savedAccounts.find(s => s.id === acc.id);
            let token = saved?.token || acc.token || tokenCache[acc.id] || "";
            if (token && curTok && token === curTok && acc.id !== currentUser?.id) token = "";
            if (token) {
                const owner = getUserIdFromToken(token);
                if (owner && owner !== acc.id) token = "";
            }
            result.push({ ...acc, token, hasToken: !!token, isNative: true });
        }

        for (const acc of savedAccounts) {
            if (seen.has(acc.id)) continue;
            seen.add(acc.id);
            let token = acc.token || tokenCache[acc.id] || "";
            if (token && curTok && token === curTok && acc.id !== currentUser?.id) token = "";
            if (token) {
                const owner = getUserIdFromToken(token);
                if (owner && owner !== acc.id) token = "";
            }
            result.push({ ...acc, token, hasToken: !!token, isNative: false });
        }
        return result;
    }, [savedAccounts, nativeAccounts, currentUser]);

    const refreshInstances = async () => {
        const ids = await Native.getOpenInstances().catch(() => []);
        setOpenInstances(ids ?? []);
    };

    const launch = async (acc: AccountEntry, mode: "detached" | "grouped") => {
        if (!acc.hasToken || !acc.token) return;

        const tokenMod = findByProps("getToken", "encryptAndStoreTokens");
        const curTok = tokenMod?.getToken?.();
        if (curTok && acc.token === curTok && acc.id !== currentUser?.id) {
            setStatus(t("Cannot launch: Token collision detected."));
            setTimeout(() => setStatus(null), 4000);
            return;
        }

        setCtx(null);
        setStatus(t(mode === "grouped" ? "Opening grouped instance…" : "Opening detached instance…"));

        const { domain, blockExternalTokenAccess, performanceMode, syncAudioSettings } = settings.store;
        const audioSettings = syncAudioSettings ? captureMasterAudioSettings() : undefined;

        const res = mode === "grouped"
            ? await Native.openInstanceWindowGrouped(acc.token, acc.id, acc.username, domain, blockExternalTokenAccess, performanceMode, audioSettings).catch(() => ({ ok: false, error: "error" }))
            : await Native.openInstanceWindow(acc.token, acc.id, true, acc.username, domain, blockExternalTokenAccess, performanceMode, audioSettings).catch(() => ({ ok: false, error: "error" }));

        if ((res as any).ok) {
            setStatus(t("Instance opened"));
            await refreshInstances();
        } else {
            setStatus(`${t("Error:")} ` + ((res as any).error ?? t("unknown")));
        }
        setTimeout(() => setStatus(null), 3000);
    };

    const openCtx = (e: React.MouseEvent, acc: AccountEntry) => {
        e.preventDefault();
        e.stopPropagation();
        setCtx({ x: e.clientX, y: e.clientY, acc });
    };

    return (
        <ModalRoot {...rootProps} size="small">
            <ModalHeader separator={false}>
                <Forms.FormTitle tag="h4" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, color: "#fff" }}>
                    <DiscordIcon /> {t("Multi-instance")}
                </Forms.FormTitle>
                <ModalCloseButton onClick={rootProps.onClose} />
            </ModalHeader>
            <ModalContent className="mi-modal-content">
                <p className="mi-subtitle">
                    <strong>{t("Left click")}</strong> {t("or")} <strong>{t("right click")}</strong> → {t("options menu")}
                </p>
                <div className="mi-list">
                    <div className="mi-section-label">
                        {allAccounts.length} {t(allAccounts.length !== 1 ? "ACCOUNTS" : "ACCOUNT")}
                    </div>
                    {allAccounts.length === 0 ? (
                        <div className="mi-empty">
                            {t("No account found.")}<br />
                            {t("Use")} "<strong>{t("Switch Account")}</strong>" {t("in Discord or add tokens via")} <strong>{t("TokenImporter")}</strong>.
                        </div>
                    ) : allAccounts.map(acc => {
                        const isCurrent = acc.id === currentUser?.id;
                        const isOpen = openInstances.includes(acc.id);
                        const tagText = isCurrent
                            ? `@${currentUser?.username ?? acc.username}`
                            : (acc.hasToken
                                ? (acc.isNative ? t("Discord Account") : t("Token"))
                                : t("Requires normal login to capture token"));
                        return (
                            <div
                                key={acc.id}
                                className={`mi-account-row${isCurrent ? " mi-account-row-current" : ""}${isOpen ? " mi-account-row-active" : ""}${!acc.hasToken && !isCurrent ? " mi-account-row-no-token" : ""}`}
                                onClick={e => openCtx(e, acc)}
                                onContextMenu={e => openCtx(e, acc)}
                            >
                                <AccountAvatar url={acc.avatar} name={acc.username} />
                                <div className="mi-account-info">
                                    <span className="mi-account-name">{acc.username}</span>
                                    <span className="mi-account-tag">{tagText}</span>
                                </div>
                                {isCurrent ? (
                                    <span className="mi-badge-current">{t("Active")}</span>
                                ) : acc.hasToken ? (
                                    isOpen ? <span className="mi-badge-open">{t("Open")}</span>
                                               : <span className="mi-badge-arrow">›</span>
                                ) : (
                                    <span className="mi-badge-lock"><LockIcon /></span>
                                )}
                            </div>
                        );
                    })}
                </div>

                {status && (
                    <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", textAlign: "center", margin: "4px 0 0" }}>
                        {status}
                    </p>
                )}
            </ModalContent>
            {ctx && (() => {
                const acc = allAccounts.find(a => a.id === ctx.acc.id);
                if (!acc) return null;
                return (
                    <ContextMenuPortal
                        x={ctx.x}
                        y={ctx.y}
                        acc={acc}
                        isOpen={openInstances.includes(acc.id)}
                        onClose={() => setCtx(null)}
                        onNewWindow={() => launch(acc, "detached")}
                        onNewDetached={() => launch(acc, "detached")}
                        onNewGrouped={() => launch(acc, "grouped")}
                        onSwitch={() => acc.token ? switchToQuick(acc.token, acc.id) : switchNativeAccount(acc.id)}
                    />
                );
            })()}
        </ModalRoot>
    );
}

function AccountAvatar({ url, name }: { url: string; name: string; }) {
    const [err, setErr] = React.useState(false);
    if (err || !url) return <div className="mi-avatar mi-avatar-ph">{name?.[0]?.toUpperCase() ?? "?"}</div>;
    return <img src={url} className="mi-avatar" alt="" onError={() => setErr(true)} />;
}

function LockIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
        </svg>
    );
}

function DiscordIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.73 4.87a18.2 18.2 0 0 0-4.6-1.44c-.21.4-.4.8-.58 1.21-1.69-.25-3.4-.25-5.1 0-.18-.41-.37-.82-.59-1.2-1.6.27-3.14.75-4.6 1.43A19.04 19.04 0 0 0 .96 17.7a18.43 18.43 0 0 0 5.63 2.87c.46-.62.86-1.28 1.2-1.98-.65-.25-1.29-.55-1.9-.92.17-.12.32-.24.47-.37 3.58 1.7 7.7 1.7 11.28 0l.46.37c-.6.36-1.25.67-1.9.92.35.7.75 1.35 1.2 1.98 2.03-.63 3.94-1.6 5.64-2.87.47-4.87-.78-9.09-3.3-12.83ZM8.3 15.12c-1.1 0-2-1.02-2-2.27 0-1.24.88-2.26 2-2.26s2.02 1.02 2 2.26c0 1.25-.89 2.27-2 2.27Zm7.4 0c-1.1 0-2-1.02-2-2.27 0-1.24.88-2.26 2-2.26s2.02 1.02 2 2.26c0 1.25-.88 2.27-2 2.27Z" />
        </svg>
    );
}

function WindowIcon() {
    return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z" />
        </svg>
    );
}

function SwitchIcon() {
    return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 17v-3H9v-4h7V7l5 5-5 5zm-9 2H5V5h2V3H5C3.9 3 3 3.9 3 5v14c0 1.1.9 2 2 2h2v-2z" />
        </svg>
    );
}

function GroupedIcon() {
    return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2 7h20v2H2zm0 4h20v2H2zm0 4h20v2H2z" />
        </svg>
    );
}

function CloseIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
        </svg>
    );
}

function MultiInstanceIcon({ width = 20, height = 20, className = "" }: { width?: number; height?: number; className?: string; }) {
    return (
        <svg className={`nc-multi-instance-icon ${className}`} width={width} height={height} viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.73 4.87a18.2 18.2 0 0 0-4.6-1.44c-.21.4-.4.8-.58 1.21-1.69-.25-3.4-.25-5.1 0-.18-.41-.37-.82-.59-1.2-1.6.27-3.14.75-4.6 1.43A19.04 19.04 0 0 0 .96 17.7a18.43 18.43 0 0 0 5.63 2.87c.46-.62.86-1.28 1.2-1.98-.65-.25-1.29-.55-1.9-.92.17-.12.32-.24.47-.37 3.58 1.7 7.7 1.7 11.28 0l.46.37c-.6.36-1.25.67-1.9.92.35.7.75 1.35 1.2 1.98 2.03-.63 3.94-1.6 5.64-2.87.47-4.87-.78-9.09-3.3-12.83ZM8.3 15.12c-1.1 0-2-1.02-2-2.27 0-1.24.88-2.26 2-2.26s2.02 1.02 2 2.26c0 1.25-.89 2.27-2 2.27Zm7.4 0c-1.1 0-2-1.02-2-2.27 0-1.24.88-2.26 2-2.26s2.02 1.02 2 2.26c0 1.25-.88 2.27-2 2.27Z" />
            <circle cx="19.5" cy="19.5" r="4.5" fill="var(--brand-500, #5865f2)" />
            <path d="M19.5 17.5v4M17.5 19.5h4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
    );
}

function MultiInstanceButton() {
    return (
        <div
            role="button"
            tabIndex={0}
            title={t("Multi-instance — open Discord with another account")}
            className="nc-multi-instance-btn"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 4, cursor: "pointer" }}
            onClick={() => openModal(props => <MultiInstanceModal rootProps={props} />)}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") openModal(props => <MultiInstanceModal rootProps={props} />); }}
        >
            <MultiInstanceIcon />
        </div>
    );
}

async function initInstanceWindowAuth(): Promise<void> {
    let auth: { token: string; userId: string; username: string; } | null = null;
    try {
        if (typeof Native?.getInstanceAuth === "function") auth = await Native.getInstanceAuth();
    } catch (e) {
        console.warn("[NightcordMI] getInstanceAuth IPC error:", e);
    }

    const miToken = auth?.token || (window as any).__nightcord_token;
    const miUserId = auth?.userId || (window as any).__nightcord_user_id || getUserIdFromToken(miToken || "");
    if (!miToken || typeof miToken !== "string") return;

    let cleanTok = miToken.trim().replace(/^"+|"+$/g, "");
    if (!cleanTok || cleanTok === "undefined") return;
    if (cleanTok.startsWith("dQw4w9WgXcQ:")) {
        try {
            const dec = await Native.decryptToken(cleanTok);
            if (dec) cleanTok = dec;
        } catch {}
    }
    if (cleanTok.startsWith("dQw4w9WgXcQ:")) return;

    console.log("[NightcordMI] Instance token acquired for userId:", miUserId);
    let encryptedTok = "";
    try {
        if (typeof (Native as any)?.encryptToken === "function") {
            encryptedTok = await (Native as any).encryptToken(cleanTok);
        }
    } catch {}

    const tokensMap: Record<string, string> = {};
    if (miUserId && encryptedTok) tokensMap[miUserId] = encryptedTok;
    const tokensJson = Object.keys(tokensMap).length > 0 ? JSON.stringify(tokensMap) : "";

    const syncStorage = () => {
        try {
            const q = JSON.stringify(cleanTok);
            window.localStorage.setItem("token", q);
            window.localStorage.setItem("default_token", q);
            if (miUserId) window.localStorage.setItem("user_id_cache", JSON.stringify(miUserId));
            if (tokensJson) {
                window.localStorage.setItem("tokens", tokensJson);
                window.localStorage.setItem("multiaccount_tokens", tokensJson);
            }
            const iframe = document.createElement("iframe");
            iframe.style.display = "none";
            document.body.appendChild(iframe);
            const ifLs = (iframe as any).contentWindow?.localStorage;
            if (ifLs) {
                ifLs.token = q;
                ifLs.default_token = q;
                if (miUserId) ifLs.user_id_cache = JSON.stringify(miUserId);
                if (tokensJson) {
                    ifLs.tokens = tokensJson;
                    ifLs.multiaccount_tokens = tokensJson;
                }
            }
            document.body.removeChild(iframe);
        } catch (e) {
            console.warn("[NightcordMI] syncStorage error:", e);
        }
    };
    syncStorage();

    const checkAuthAndRoute = () => {
        const authStore = findByProps("getToken", "getId");
        if (authStore?.getToken?.() === cleanTok && authStore?.getId?.()) {
            console.log("[NightcordMI] User authenticated successfully!");
            const router = findByProps("transitionTo", "replaceWith");
            if ((window.location.pathname.includes("/login") || window.location.pathname === "/") && router?.transitionTo) {
                router.transitionTo("/channels/@me");
            }
            return true;
        }
        return false;
    };

    if (checkAuthAndRoute()) return;

    let loginTriggered = false;
    const triggerLogin = (loginMod: any) => {
        if (loginTriggered || !loginMod?.loginToken) return;
        loginTriggered = true;
        try { loginMod.loginToken(cleanTok); } catch (e) { console.warn("[NightcordMI] loginToken error:", e); }
        const dispatcher = findByProps("dispatch", "subscribe") || FluxDispatcher;
        if (dispatcher?.dispatch) {
            try {
                dispatcher.dispatch({ type: "LOGIN", token: cleanTok });
                dispatcher.dispatch({ type: "LOGIN_SUCCESS", token: cleanTok });
                if (miUserId) {
                    dispatcher.dispatch({ type: "MULTI_ACCOUNT_VALIDATE_TOKEN_SUCCESS", token: cleanTok, userId: miUserId });
                }
            } catch {}
        }
    };

    const immediateLoginMod = findByProps("loginToken") || findByProps("switchAccount", "loginToken");
    if (immediateLoginMod) triggerLogin(immediateLoginMod);
    else waitFor(["loginToken"], mod => triggerLogin(mod));

    const routeToMe = () => {
        const router = findByProps("transitionTo", "replaceWith");
        if ((window.location.pathname.includes("/login") || window.location.pathname === "/") && router?.transitionTo) {
            router.transitionTo("/channels/@me");
        }
    };

    waitFor(["dispatch", "subscribe"], (dispatcher: any) => {
        const unConn = dispatcher.subscribe("CONNECTION_OPEN", () => {
            try { unConn(); } catch {}
            routeToMe();
        });
        dispatcher.subscribe("LOGIN_SUCCESS", () => setTimeout(checkAuthAndRoute, 500));
    });

    if (settings.store.syncAudioSettings !== false) syncInstanceAudioSettings();

    [1000, 2500, 5000].forEach(delay => {
        setTimeout(() => {
            syncStorage();
            if (!checkAuthAndRoute() && !loginTriggered) {
                const mod = findByProps("loginToken") || findByProps("switchAccount", "loginToken");
                if (mod) triggerLogin(mod);
            }
        }, delay);
    });
}

export default definePlugin({
    name: "MultiInstance",
    enabledByDefault: true,
    description: "Opens a 2nd Discord (new window or split screen) with another account.",
    authors: AUTHORS as any,
    dependencies: ["HeaderBarAPI"],
    settings,
    _fluxUnsub: null as (() => void) | null,
    async start() {
        await initInstanceWindowAuth();
        await loadTokenCache();
        hookEncryptAndStoreTokens();
        this._fluxUnsub = hookFluxDispatcher();
        captureCurrentToken();
        fetchAllAccounts().catch(() => {});
        if (!isCurrentInstanceWindow()) {
            scheduleMasterAudioSave();
            hookAudioSettingsWatcher();
        }
        addHeaderBarButton("nightcord-multi-instance", () => <MultiInstanceButton />, 9);
    },
    stop() {
        removeHeaderBarButton("nightcord-multi-instance");
        if (this._fluxUnsub) { this._fluxUnsub(); this._fluxUnsub = null; }
        if (unhookAudioWatcher) { unhookAudioWatcher(); }
        const root = document.getElementById("nightcord-mi-ctx-root");
        if (root) root.remove();
    },
});

initInstanceWindowAuth().catch(err => console.warn("[NightcordMI] initInstanceWindowAuth error:", err));
