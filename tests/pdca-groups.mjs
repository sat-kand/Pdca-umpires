// The tests use PDCA's own fixtures, so they start with the groups PDCA's competitions suggest.
import { setGroups } from '../js/logic.js';
import { setPlayerUmpireGroups } from '../js/player-umpire.js';
export const PDCA = {
  name: 'Parramatta District Cricket Association',
  groups: [{ key: 'senior', name: 'Senior' }, { key: 'junior', name: 'Junior' }, { key: 't20', name: 'T20' }],
};
export function usePdcaGroups() { setGroups(PDCA); setPlayerUmpireGroups(null, ['senior', 'junior', 't20']); }
usePdcaGroups();
