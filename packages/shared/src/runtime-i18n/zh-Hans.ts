import type { RuntimeTranslations } from './en.js';

export const ZH_HANS_RUNTIME_TRANSLATIONS = {
  'plan.entry.title': '进入计划模式',
  'plan.entry.question': '要为此任务进入计划模式吗？',
  'plan.entry.confirm.label': '确认',
  'plan.entry.confirm.description': '在实施前先进行调研并制定计划。',
  'plan.entry.decline.label': '拒绝',
  'plan.entry.decline.description': '继续执行，不进入计划模式。',
  'plan.implementation.display': '实施此计划',
  'questionnaire.noAnswer': '未回答',
  'questionnaire.others': '其他',
} as const satisfies RuntimeTranslations;
