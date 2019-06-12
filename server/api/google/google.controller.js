const logger = require('../../modules/logger');

const google = require('../../modules/google');

async function googleAuthMiddleware (ctx, next) {
  const auth = google.createConnection();
  auth.setCredentials(ctx.state.user.integrations.google.tokens);
  ctx.state.googleAuth = auth;
  await next();
}

async function createCourseSchedule (ctx) {
  const courses = await ctx.state.user.getCoursesForTerm(ctx.session.currentTerm.code);

  await google.actions.createRecurringEventsFromCourseSchedule(ctx, courses);

  ctx.ok({
    message: 'good'
  });
}

async function listCalendars (ctx) {
  const calendar = google.apis.calendar({
    version: 'v3',
    auth: ctx.state.googleAuth
  });
  let request;
  try {
    request = await calendar.calendarList.list(ctx.request.query);
  } catch (e) {
    logger.error(
      `Failed to get GCal calendar list for ${ctx.state.user.rcs_id}: ${e}`
    );
    return ctx.internalServerError(
      'There was an error getting your calendars from Google!'
    );
  }
  ctx.ok({
    calendars: request.data.items
  });
}

async function createCalendar (ctx) {
  const calendar = google.apis.calendar({
    version: 'v3',
    auth: ctx.state.googleAuth
  });

  const { calendarType, summary, description } = ctx.request.body;

  let request;
  try {
    request = await calendar.calendars.insert({
      requestBody: {
        summary,
        description,
        timeZone: 'America/New_York',
        location: 'RPI'
      }
    });

    await calendar.calendarList.patch({
      calendarId: request.data.id,
      requestBody: {
        defaultReminders: [
          {
            method: 'popup',
            minutes: 15
          }
        ]
      }
    });
  } catch (e) {
    logger.error(
      `Failed to create new calendar for ${ctx.state.user.rcs_id}: ${e}`
    );
    return ctx.badRequest('Failed to create new Google Calendar.');
  }

  ctx.state.user.integrations.google.calendarIDs[calendarType] =
    request.data.id;
  if (calendarType === 'workBlocks') {
    ctx.state.user.notificationPreferences.preWorkBlockReminders =
      'google calendar';
  }
  await ctx.state.user.save();

  ctx.ok({ createdCalendar: request.data, updatedUser: ctx.state.user });
}

module.exports = {
  googleAuthMiddleware,
  listCalendars,
  createCalendar,
  createCourseSchedule
};
