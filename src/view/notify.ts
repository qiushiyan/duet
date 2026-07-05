import { execa } from 'execa';

/**
 * Best-effort desktop ping at every quiescent stop — the AFK phase's whole
 * point is that the human is elsewhere when a gate or queued question lands.
 * macOS-only (personal tool), and never allowed to affect the run: a failed
 * notification is silently dropped, the state on disk is the real signal.
 */
export async function notify(title: string, message: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`;
    await execa('osascript', ['-e', script], { timeout: 5_000 });
  } catch {
    // Deliberately swallowed — duet status carries the same information.
  }
}
