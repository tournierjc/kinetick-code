export const MINIMAX_CODE_WELCOME_PASTE_IMAGE_SHORTCUT = '{paste-image-shortcut}';

export const MINIMAX_CODE_WELCOME_DESIGN = {
  sectionTitles: {
    tips: 'Tips for getting started',
    news: "What's new · /changelog for history",
  },
  tipPool: [
    'Say what you want and how to verify it.',
    `Use @ for files; ${MINIMAX_CODE_WELCOME_PASTE_IMAGE_SHORTCUT} for images.`,
    'Run /init to teach KCode this repo.',
    'Use /plan before a change that needs design or investigation.',
    'Use /context to check the current Session context budget.',
    'Use /sessions to resume earlier work.',
    'Use /history to review and branch from earlier prompts.',
    'Use /goal to keep long-running work focused on a finish line.',
    'Use /permission to choose how KCode handles tool approvals.',
    'Use /feedback to preview a redacted report before upload.',
  ],
  wide: {
    tips: [
      'Say what you want and how to verify it.',
      `Use @ for files; ${MINIMAX_CODE_WELCOME_PASTE_IMAGE_SHORTCUT} for images.`,
      'Run /init to teach KCode this repo.',
    ],
    news: [
      'Send follow-ups while KCode works.',
      '/context shows read-only session context.',
      '/feedback previews before upload.',
    ],
  },
  stacked: {
    tips: [
      'Say what you want and how to verify it.',
      `@ files · ${MINIMAX_CODE_WELCOME_PASTE_IMAGE_SHORTCUT} images · /init guidance`,
    ],
    news: ['Follow-ups wait while KCode works.', '/context budget · /feedback preview'],
  },
  compact: {
    tips: [
      `@ files · ${MINIMAX_CODE_WELCOME_PASTE_IMAGE_SHORTCUT} images`,
      '/init repo guidance',
    ],
    news: ['Follow-ups wait', '/context · /feedback'],
  },
  hero: {
    fullMinWidth: 94,
    mediumMinWidth: 41,
    microMinWidth: 8,
    fallbackTitle: 'K',
  },
} as const;

export const MINIMAX_CODE_TERMINAL_WORDMARK = [
  '██╗  ██╗██╗███╗   ██╗███████╗████████╗██╗ ██████╗██╗  ██╗     ██████╗ ██████╗ ██████╗ ███████╗',
  '██║ ██╔╝██║████╗  ██║██╔════╝╚══██╔══╝██║██╔════╝██║ ██╔╝    ██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '█████╔╝ ██║██╔██╗ ██║█████╗     ██║   ██║██║     █████╔╝     ██║     ██║   ██║██║  ██║█████╗',
  '██╔═██╗ ██║██║╚██╗██║██╔══╝     ██║   ██║██║     ██╔═██╗     ██║     ██║   ██║██║  ██║██╔══╝',
  '██║  ██╗██║██║ ╚████║███████╗   ██║   ██║╚██████╗██║  ██╗    ╚██████╗╚██████╔╝██████╔╝███████╗',
  '╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝╚══════╝   ╚═╝   ╚═╝ ╚═════╝╚═╝  ╚═╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
] as const;

export const MINIMAX_CODE_TERMINAL_MEDIUM_WORDMARK = [
  '██╗  ██╗ ██████╗ ██████╗ ██████╗ ███████╗',
  '██║ ██╔╝██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '█████╔╝ ██║     ██║   ██║██║  ██║█████╗',
  '██╔═██╗ ██║     ██║   ██║██║  ██║██╔══╝',
  '██║  ██╗╚██████╗╚██████╔╝██████╔╝███████╗',
  '╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
] as const;

export const MINIMAX_CODE_TERMINAL_MICRO_WORDMARK = [
  '██╗  ██╗',
  '██║ ██╔╝',
  '█████╔╝',
  '██╔═██╗',
  '██║  ██╗',
  '╚═╝  ╚═╝',
] as const;
