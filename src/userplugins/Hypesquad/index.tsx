/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { RestAPI, showToast } from "@webpack/common";
const HOUSE_NAMES: Record<number, string> = {
    0: "None",
    1: "Bravery",
    2: "Brilliance",
    3: "Balance",
};

const settings = definePluginSettings({
    currentHouse: {
        type: OptionType.SELECT,
        description: "Your current HypeSquad house",
        options: [
            { label: "Remove Badge",     value: 0, default: true },
            { label: "House Bravery",    value: 1 },
            { label: "House Brilliance", value: 2 },
            { label: "House Balance",    value: 3 },
        ],
    },
});

async function applyHouse(houseId: number, channelId?: string) {
    const reply = (content: string) =>
        channelId ? sendBotMessage(channelId, { content }) : showToast(content);
    try {
        if (houseId === 0) {
            await RestAPI.del({ url: "/hypesquad/online" });
            reply("HypeSquad badge removed");
            return;
        }
        if (![1, 2, 3].includes(houseId)) {
            reply("Invalid house ID. Use 0 (remove), 1 (Bravery), 2 (Brilliance), or 3 (Balance)");
            return;
        }
        await RestAPI.post({ url: "/hypesquad/online", body: { house_id: houseId } });
        reply(`HypeSquad set to ${HOUSE_NAMES[houseId]}`);
    } catch (error) {
        reply(`Request failed: ${error}`);
    }
}

export default definePlugin({
    name: "HypeSquadSwitcher",
    description: "Easily switch between HypeSquad houses or remove your badge",
    authors: [Yapcord],
    settings,
    commands: [
        {
            name: "hypesquad",
            description: "Apply or remove your HypeSquad badge",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "house",
                    description: "0: Remove | 1: Bravery | 2: Brilliance | 3: Balance",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: true,
                    choices: [
                        { name: "Remove Badge",     value: 0 },
                        { name: "House Bravery",    value: 1 },
                        { name: "House Brilliance", value: 2 },
                        { name: "House Balance",    value: 3 },
                    ],
                },
            ],
            execute: async (args, ctx) => {
                const houseId = Number(args[0].value);
                await applyHouse(houseId, ctx.channel?.id);
                settings.store.currentHouse = houseId;
            },
        },
    ],
});
