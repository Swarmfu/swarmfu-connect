import { createInterface } from "node:readline/promises";

/** Whether someone's at the keyboard (a terminal, or a double-clicked window). */
export const interactive = (): boolean => !!process.stdin.isTTY;

/** One line from the user. */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Keeps a double-clicked window open until they've read what happened. */
export async function waitToClose(): Promise<void> {
  if (!interactive()) return;
  await ask("Press Enter to close.");
}
