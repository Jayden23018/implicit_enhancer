import { getKey, hasKey } from '../../utils/keys.js';
import { strictFormat } from '../../utils/text.js';

export class Enhancer {
    constructor(config) {
        this.model = config.model;
        this.config = config;
    }

    async sendRequest(model, turns, systemPrompt, stop_seq='***') {
        let res = await this.model.sendRequest(turns, systemPrompt, stop_seq='***');
        return res;
    }
    
    async sendVisionRequest(model, messages, systemMessage, imageBuffer) {
        let res = await this.model.sendVisionRequest(messages, systemMessage, imageBuffer);
        return res;
    }
}