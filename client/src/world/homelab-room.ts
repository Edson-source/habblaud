import type { RoomInfo } from '../../../shared/types';
import { hash32 } from '../../../shared/hash';

export const HOMELAB_ROOM_ID = 'habblaud:HomeLab';

export const HOMELAB_ROOM_INFO: RoomInfo = {
  id: HOMELAB_ROOM_ID,
  name: 'HomeLab',
  path: '/HomeLab',
  slot: Number.MAX_SAFE_INTEGER,
  seed: hash32(HOMELAB_ROOM_ID),
  createdAt: 0,
};

export function isHomeLabRoom(room: Pick<RoomInfo, 'name' | 'path'>): boolean {
  const name = room.name.trim().toLocaleLowerCase('en');
  const path = room.path.replace(/[\\/]+$/, '');
  const basename = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLocaleLowerCase('en');
  return name === 'HomeLab' || basename === 'HomeLab';
}
