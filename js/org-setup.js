// An association's own set-up, applied whenever it is opened or its settings change: its groups (Allocate
// tiles, availability, reports) and which groups player umpires choose from.
import { setGroups, COMPS, setMembershipRequired, joinSettings } from './logic.js';
import { setPlayerUmpireGroups } from './player-umpire.js';

export function applyOrg(org) {
  setGroups(org);
  setMembershipRequired(joinSettings(org).membershipRequired);
  setPlayerUmpireGroups(org, COMPS.map(c => c.key));
}
