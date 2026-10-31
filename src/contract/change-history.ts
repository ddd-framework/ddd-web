import type { DddDateTimeString } from './datetime';

/**
 * `DDD.Domain.Base.Entities.ChangeHistory.ChangeHistory` as it appears on entities using the ChangeHistory trait.
 * Both times are DDD date-times (`Y-m-d H:i:s`, UTC); parse them with `parseDddDateTime()`. The backend fills them
 * on persist; a client never needs to send them (`overwriteCreatedAndModifiedTime` is hidden from responses).
 */
export interface ChangeHistory {
  /** Time the entity was created and persisted. */
  createdTime?: DddDateTimeString | null;
  /** Time the entity was last modified and persisted. */
  modifiedTime?: DddDateTimeString | null;
  objectType?: string | null;
}
