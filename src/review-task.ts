import type { Task } from './analyzer';

/** Preserve source text. A title is optional in the paste-first UI, but required by the API. */
export function prepareReviewTask(task: Task): Task {
  const description = task.description.trim();
  const heading = description.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
  const title = task.title.trim() || heading.slice(0, 120);
  return { ...task, title, description };
}

export function reviewTextLength(task: Task): number {
  const prepared = prepareReviewTask(task);
  return prepared.title.length + prepared.description.length + prepared.criteria.length + prepared.context.length;
}

export function reviewInputValid(task: Task): boolean {
  const prepared = prepareReviewTask(task);
  return prepared.title.length > 0 && prepared.title.length <= 180 &&
    prepared.description.length > 0 && prepared.description.length <= 6500 &&
    prepared.criteria.length <= 1200 && prepared.context.length <= 1200 &&
    reviewTextLength(task) <= 8000;
}
