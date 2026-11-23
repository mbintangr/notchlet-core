export class WorkflowError extends Error {
  constructor(public readonly code: string, message: string, public readonly recovery: string) { super(message); this.name = 'WorkflowError'; }
}
