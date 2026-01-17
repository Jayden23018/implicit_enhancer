
import { Vec3 } from 'vec3';
import { readdirSync, readFileSync } from 'fs';
import { runAsAction } from '../../agent/commands/actions.js';
import * as skills from '../../agent/library/skills.js';
import * as world from '../../agent/library/world.js';
import * as mc from '../../utils/mcdata.js';

export class PluginInstance {
    constructor(agent) {
        this.agent = agent;
        this.memory = {}
    }

    init() {
    }

    getPluginActions() {
        return [
            {
                name: '!rememberHere',
                description: 'Save the current location with a given name.',
                params: {'name': { type: 'string', description: 'The name to remember the location as.' }},
                perform: async function (agent, name) {
                    const pos = agent.bot.entity.position;
                    agent.plugin.plugins["MemoryBank"].rememberPlace(name, pos.x, pos.y, pos.z);
                    return `Location saved as "${name}".`;
                }
            },
            {
                name: '!goToRememberedPlace',
                description: 'Go to a saved location.',
                params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
                perform: runAsAction(async (agent, name) => {
                    const pos = agent.plugin.plugins["MemoryBank"].recallPlace(name);
                    if (!pos) {
                    skills.log(agent.bot, `No location named "${name}" saved.`);
                    return;
                    }
                    await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
                })
            },
            {
                name: '!savedPlaces',
                description: 'List all saved locations.',
                perform: async function (agent) {
                    return "Saved place names: " + agent.plugin.plugins["MemoryBank"].getKeys();
                }
            },
        ]
    }

    rememberPlace(name, x, y, z) {
		this.memory[name] = [x, y, z];
	}

	recallPlace(name) {
		return this.memory[name];
	}

	getJson() {
		return this.memory
	}

	loadJson(json) {
		this.memory = json;
	}

	getKeys() {
		return Object.keys(this.memory).join(', ')
	}
}