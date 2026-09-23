export interface TuiCommandDescriptor {
  readonly name: string;
  readonly description: string;
}

export const TUI_COMMAND_DESCRIPTORS = {
  help: {
    name: 'help',
    description: 'Show available commands',
  },
  new: {
    name: 'new',
    // Shared with the ACP command list, where the client opens the thread: the TUI
    // catalog states the tab, which is what it opens there.
    description: 'Open a new Session',
  },
  model: {
    name: 'model',
    description: 'Choose a model',
  },
  status: {
    name: 'status',
    description: 'Show account and model status',
  },
  doctor: {
    name: 'doctor',
    description: 'Check the local config file',
  },
  context: {
    name: 'context',
    description: 'Show the Runtime-owned context snapshot',
  },
  skills: {
    name: 'skills',
    description: 'List built-in and user Skills',
  },
  mcp: {
    name: 'mcp',
    description: 'Inspect MCP capabilities and project configuration',
  },
  usage: {
    name: 'usage',
    description: 'Show session usage',
  },
  cost: {
    name: 'cost',
    description: 'Show session cost by model, including sub-agents',
  },
  compact: {
    name: 'compact',
    description: 'Shorten the active conversation',
  },
  export: {
    name: 'export',
    description: 'Export the current Session as Markdown',
  },
} as const satisfies Record<string, TuiCommandDescriptor>;
