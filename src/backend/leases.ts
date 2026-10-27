/** One browser document controls automation for a user. Dead documents expire. */
export class Leases {
  private owners = new Map<string, { session: string; at: number }>();
  constructor(private now = Date.now, private ttl = 60_000) {}
  claim(user: string, session: string): boolean {
    const owner = this.owners.get(user);
    if (owner && owner.session !== session && this.now() - owner.at < this.ttl) return false;
    this.owners.set(user, { session, at: this.now() });
    return true;
  }
  heartbeat(user: string, session: string): boolean {
    const owner = this.owners.get(user);
    if (!owner || owner.session !== session || this.now() - owner.at >= this.ttl) return false;
    owner.at = this.now(); return true;
  }
  valid(user: string, session: string): boolean {
    const owner = this.owners.get(user);
    return !!owner && owner.session === session && this.now() - owner.at < this.ttl;
  }
  release(user: string, session: string): boolean {
    if (this.owners.get(user)?.session !== session) return false;
    this.owners.delete(user); return true;
  }
}
