import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Lightweight shared task ledger for multiple agents.
 * Stores JSON on disk so separate processes can read/write.
 */
export class SharedMemory {
    constructor(options = {}) {
        this.agentName = options.agentName || 'unknown_agent';
        this.statePath = options.path || join(process.cwd(), 'bots', '_shared', 'team_state.json');
        mkdirSync(dirname(this.statePath), { recursive: true });
        if (!existsSync(this.statePath)) {
            writeFileSync(this.statePath, JSON.stringify({ tasks: [] }, null, 2), 'utf8');
        }
    }

    _load() {
        try {
            const raw = readFileSync(this.statePath, 'utf8');
            return JSON.parse(raw);
        } catch (err) {
            console.warn('SharedMemory load failed, resetting state:', err);
            return { tasks: [] };
        }
    }

    _save(state) {
        writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8');
    }

    listActive({ excludeAgent } = {}) {
        const state = this._load();
        return (state.tasks || []).filter(t => {
            const active = t.status === 'planning' || t.status === 'in_progress';
            const notExcluded = !excludeAgent || t.agent !== excludeAgent;
            return active && notExcluded;
        });
    }

    claimTask({ agent, intent, summary, status = 'planning' }) {
        const state = this._load();
        const now = new Date().toISOString();
        const taskSummary = (summary || intent?.input || intent?.type || '').slice(0, 120);

        // Avoid duplicate entries for the same agent + same summary if already active
        const existing = (state.tasks || []).find(
            t => t.agent === agent && t.summary === taskSummary && (t.status === 'planning' || t.status === 'in_progress')
        );
        if (existing) {
            return existing;
        }

        const task = {
            id: `task_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            agent: agent || this.agentName,
            intent: intent || {},
            summary: taskSummary,
            status,
            createdAt: now,
            updatedAt: now
        };
        state.tasks = state.tasks || [];
        state.tasks.push(task);
        this._save(state);
        return task;
    }

    updateStatus(id, status, extra = {}) {
        const state = this._load();
        const task = (state.tasks || []).find(t => t.id === id);
        if (!task) return null;
        task.status = status;
        task.updatedAt = new Date().toISOString();
        Object.assign(task, extra);
        this._save(state);
        return task;
    }

    completeTask(id, result) {
        return this.updateStatus(id, 'done', { result });
    }
}
