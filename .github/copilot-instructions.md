# Minecraft AI Copilot Instructions

This document guides AI coding assistants in understanding and contributing to the Minecraft AI project - a platform for creating intelligent AI Characters (AICs) in Minecraft that can interact, build, and engage with players.

## Project Architecture

### Core Components

1. **Agent System** (`src/agent/`)
   - `agent.js`: Central agent management
   - `plugin.js`: Plugin system implementation
   - `memory.js`: Memory and context tracking
   - `conversation.js`: Handles agent interactions

2. **Models** (`src/models/`)
   - Support for multiple AI providers (GPT, Claude, Gemini, etc.)
   - Enhancer pattern for request optimization (`enhancers/`)
   - Model-specific implementations in separate files

3. **Plugin System** (`src/plugins/`)
   - Modular architecture for extending agent capabilities
   - Each plugin in its own directory with `main.js`
   - Required structure: `PluginInstance` class with `init()` and `getPluginActions()`

### Key Files

- `settings.js`: Global configuration including active plugins
- `main.js`: Application entry point
- `src/agent/commands/actions.js`: Core action definitions

## Development Workflows

### Adding New Features

1. **Plugin Development** (Preferred Method)
   ```
   src/plugins/NewFeature/
   ├── main.js          # Required
   ├── README.md        # Document usage
   └── [other files]    # Optional
   ```

2. **Enable Plugin**
   Add to `settings.plugins` array:
   ```javascript
   plugins = ["NewFeature", "OtherPlugins"]
   ```

### Core Patterns

1. **Enhancer Pattern**
   - Base class: `enhancers/enhancer.js`
   - Extend for custom request processing
   - Example: `implicit_enhancer.js` for context-aware requests

2. **Plugin Actions**
   - Define in `getPluginActions()`
   - Format matches `src/agent/commands/actions.js`
   - Auto-registered during plugin initialization

3. **Agent Communication**
   - Use `conversation.js` for inter-agent messaging
   - Handle async operations with proper error handling

## Integration Points

1. **Model Integration**
   - Implement model-specific classes in `src/models/`
   - Follow existing patterns (e.g., `gemini.js`, `gpt.js`)
   - Use enhancers for request processing

2. **Plugin Integration**
   - Access agent context via constructor injection
   - Use `this.agent` for core functionality
   - Register actions through `getPluginActions()`

## Project Conventions

1. **Code Organization**
   - Core features in `src/agent/`
   - Optional features as plugins
   - Model implementations in `src/models/`

2. **Error Handling**
   - Async/await for asynchronous operations
   - Proper error propagation in plugins
   - Console logging for debugging

3. **Plugin Development**
   - Self-contained in plugin directory
   - Document usage in plugin README
   - No modifications outside plugin scope

4. **Testing**
   - Test plugins independently
   - Document test scenarios in README
   - Verify with multiple agent configurations

Remember: Focus on modular design through plugins rather than modifying core files whenever possible.
