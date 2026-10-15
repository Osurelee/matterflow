/** 共享业务冲突错误（独立模块，避免 services 之间循环依赖）。 */
export class MutationConflict extends Error {
  constructor(
    message: string,
    readonly code = 'CONFLICT',
    readonly status = 409,
    readonly details: { fieldErrors?: Record<string, string>; currentVersion?: number; current?: unknown } = {},
  ) { super(message); }
}
