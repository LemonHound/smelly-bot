import { google } from 'googleapis';
import { logger } from '../logger.js';

const TIME_OF_DAY = {
  morning: { hour: 9, duration: 2 },
  afternoon: { hour: 14, duration: 2 },
  evening: { hour: 18, duration: 3 },
  night: { hour: 19, duration: 3 },
  lunch: { hour: 12, duration: 1 },
  dinner: { hour: 18, duration: 2 },
};

export const CREATE_CALENDAR_EVENT_SCHEMA = {
  name: 'create_calendar_event',
  description: 'Create a Google Calendar event and send invites to Slack users. Use when the group explicitly discusses meeting up, scheduling a hangout, or coordinating on a specific date and time.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Event title',
      },
      date: {
        type: 'string',
        description: 'Date in YYYY-MM-DD format',
      },
      time_of_day: {
        type: 'string',
        enum: ['morning', 'afternoon', 'evening', 'night', 'lunch', 'dinner'],
        description: 'General time period. If unsure, use "evening".',
      },
      duration_hours: {
        type: 'number',
        description: 'Duration in hours. Defaults to a sensible value for the time of day.',
      },
      attendee_slack_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Slack user IDs of everyone to invite, from the conversation context.',
      },
      notes: {
        type: 'string',
        description: 'Optional description or notes to include in the event.',
      },
    },
    required: ['title', 'date', 'attendee_slack_ids'],
  },
};

async function resolveEmails(slackClient, slackIds) {
  const results = await Promise.all(
    slackIds.map(async (id) => {
      try {
        const info = await slackClient.users.info({ user: id });
        const email = info.user?.profile?.email;
        return email ? { id, email } : null;
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

export function makeCreateCalendarEventHandler({ slackClientRef, config }) {
  return async ({ title, date, time_of_day, duration_hours, attendee_slack_ids, notes }) => {
    if (!config.GOOGLE_CALENDAR_ID) {
      return 'Google Calendar is not configured (GOOGLE_CALENDAR_ID missing).';
    }

    const timeSlot = TIME_OF_DAY[time_of_day] ?? TIME_OF_DAY.evening;
    const durationHrs = duration_hours ?? timeSlot.duration;

    const startDate = new Date(`${date}T${String(timeSlot.hour).padStart(2, '0')}:00:00`);
    const endDate = new Date(startDate.getTime() + durationHrs * 60 * 60 * 1000);

    const attendees = slackClientRef.client
      ? await resolveEmails(slackClientRef.client, attendee_slack_ids)
      : [];

    try {
      const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });
      const calendar = google.calendar({ version: 'v3', auth });

      const event = {
        summary: title,
        description: notes,
        start: { dateTime: startDate.toISOString() },
        end: { dateTime: endDate.toISOString() },
        attendees: attendees.map(a => ({ email: a.email })),
        sendUpdates: 'all',
      };

      const response = await calendar.events.insert({
        calendarId: config.GOOGLE_CALENDAR_ID,
        resource: event,
        sendNotifications: true,
      });

      const invitedNames = attendees.map(a => a.email).join(', ') || 'nobody (no emails resolved)';
      logger.info({ eventId: response.data.id, title, date }, 'Calendar event created');
      return `Event created: "${title}" on ${date} at ${startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} (${durationHrs}h). Invited: ${invitedNames}. Link: ${response.data.htmlLink}`;
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to create calendar event');
      return `Failed to create event: ${err.message}`;
    }
  };
}
