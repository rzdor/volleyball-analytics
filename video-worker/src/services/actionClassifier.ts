import { PlayContactEvent, PlayDescription, PlayActionType } from './playDescriptions';

export interface ClassifiedPlayContact extends PlayContactEvent {
  actionType: PlayActionType;
  actionConfidence: number;
  actionReason: string;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function inferActionType(
  contact: PlayContactEvent,
  index: number,
  allContacts: PlayContactEvent[],
  classifiedContacts: ClassifiedPlayContact[],
  play: Pick<PlayDescription, 'trimmedStartSeconds'>
): { actionType: PlayActionType; actionConfidence: number; actionReason: string } {
  const previous = index > 0 ? classifiedContacts[index - 1] : undefined;
  const next = index < allContacts.length - 1 ? allContacts[index + 1] : undefined;
  const isFirstContact = index === 0;
  const timeSincePlayStart = round(contact.timestamp - play.trimmedStartSeconds);
  const gapFromPrevious = previous ? round(contact.timestamp - previous.timestamp) : undefined;

  if (isFirstContact && contact.teamSide === 'main' && timeSincePlayStart <= 2) {
    return {
      actionType: 'serve',
      actionConfidence: 0.9,
      actionReason: 'First main-team contact near the start of the play',
    };
  }

  if (previous && previous.teamId === contact.teamId && previous.actionType === 'set') {
    return {
      actionType: 'attack',
      actionConfidence: 0.8,
      actionReason: 'Same-team contact immediately following a set',
    };
  }

  if (previous && previous.teamId !== contact.teamId) {
    return {
      actionType: 'pass',
      actionConfidence: 0.7,
      actionReason: `First contact after opponent touch${gapFromPrevious !== undefined ? ` (${gapFromPrevious}s gap)` : ''}`,
    };
  }

  if (next && next.teamId === contact.teamId) {
    const nextGap = round(next.timestamp - contact.timestamp);
    return {
      actionType: 'set',
      actionConfidence: 0.72,
      actionReason: `Same-team follow-up contact ${nextGap}s later`,
    };
  }

  if (isFirstContact) {
    return {
      actionType: 'pass',
      actionConfidence: 0.45,
      actionReason: 'First contact of play without clear serve signal',
    };
  }

  return {
    actionType: 'unknown',
    actionConfidence: 0.3,
    actionReason: 'Insufficient rally context to classify confidently',
  };
}

export function classifyPlayContacts(
  play: Pick<PlayDescription, 'trimmedStartSeconds' | 'contacts'>
): ClassifiedPlayContact[] {
  const classifiedContacts: ClassifiedPlayContact[] = [];

  for (const [index, contact] of play.contacts.entries()) {
    const inferred = inferActionType(contact, index, play.contacts, classifiedContacts, play);
    classifiedContacts.push({
      ...contact,
      ...inferred,
    });
  }

  return classifiedContacts;
}
