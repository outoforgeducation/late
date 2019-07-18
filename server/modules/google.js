const { google } = require('googleapis');
const logger = require('./logger');
const moment = require('moment');

const RRule = require('rrule').RRule;

function createConnection () {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URL
  );
}

function createUrl (auth) {
  return auth.generateAuthUrl({
    access_type: 'offline',
    scope: scopes
  });
}
const scopes = ['https://www.googleapis.com/auth/calendar'];

const actions = {
  async createEventFromWorkBlock (ctx, assessment, assessmentType, block) {
    const calendar = google.calendar({
      version: 'v3',
      auth: ctx.state.googleAuth
    });

    const assessmentURL = `${
      process.env.BASE_URL
    }/coursework/${assessmentType.charAt(0)}/${assessment._id}`;
    const course = await ctx.state.user.courseFromCRN(
      ctx.session.currentTerm.code,
      assessment.courseCRN
    );
    const capitalizedAssessmentType =
      assessmentType === 'assignment' ? 'Assignment' : 'Exam';

    let request = await calendar.events.insert({
      calendarId: ctx.state.user.integrations.google.calendarIDs.workBlocks,
      requestBody: {
        summary: `${
          assessmentType === 'assignment' ? 'Work on' : 'Study for'
        } ${assessment.title}`,
        description: `<b>${
          course.longname
        } ${capitalizedAssessmentType}</b> <i>${
          assessment.title
        }</i><br><br>${assessmentURL}`,
        source: {
          title: assessment.title,
          url: assessmentURL
        },
        extendedProperties: {
          private: {
            scheduledByLATE: true,
            assessmentID: assessment._id // links this event to the assessment
          }
        },
        ...block.asGoogleCalendarEvent
      }
    });

    logger.info(`Added GCal event for ${ctx.state.user.rcs_id}.`);
    return request.data;
  },
  async patchEventFromWorkBlock (ctx, blockID, updates) {
    const calendar = google.calendar({
      version: 'v3',
      auth: ctx.state.googleAuth
    });
    let request = await calendar.events.patch({
      calendarId: ctx.state.user.integrations.google.calendarIDs.workBlocks,
      eventId: blockID,
      requestBody: updates
    });

    return request.data;
  },
  async deleteEventFromWorkBlock (ctx, blockID) {
    const calendar = google.calendar({
      version: 'v3',
      auth: ctx.state.googleAuth
    });

    let request = await calendar.events.delete({
      calendarId: ctx.state.user.integrations.google.calendarIDs.workBlocks,
      eventId: blockID
    });

    logger.info(`Deleted work block GCal event for ${ctx.state.user.rcs_id}.`);

    return request.data;
  },
  async createRecurringEventsFromCourseSchedule (ctx, courses) {
    const calendar = google.calendar({
      version: 'v3',
      auth: ctx.state.googleAuth
    });

    const dayAbbreviations = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    const periodTypes = {
      LEC: 'Lecture',
      LAB: 'Lab',
      TES: 'Test',
      REC: 'Recitation',
      STU: 'Studio'
    };

    for (let course of courses) {
      const courseStart = moment(course.startDate);
      const courseEnd = moment(course.endDate);

      for (let period of course.periods) {
        const start = moment(
          courseStart.format('YYYY-MM-DD') + ' ' + period.start,
          'YYYY-MM-DD Hmm',
          true
        );
        while (start.day() !== period.day) {
          start.add(1, 'day');
        }

        const end = moment(
          start.format('YYYY-MM-DD') + ' ' + period.end,
          'YYYY-MM-DD Hmm',
          true
        );
        const recurrence = new RRule({
          freq: RRule.WEEKLY,
          byweekday: [RRule[dayAbbreviations[period.day]]],
          until: courseEnd.toDate()
        });

        let request = await calendar.events.insert({
          calendarId:
            ctx.state.user.integrations.google.calendarIDs.courseSchedule,
          requestBody: {
            summary: `${course.title} ${periodTypes[period.type] ||
              period.type}`,
            description: `${course.summary} - ${course.sectionId} - ${
              course.credits
            } credits`,
            location: period.location,
            source: {
              title: 'Course Page',
              url: process.env.BASE_URL + '/account/courses'
            },
            start: {
              dateTime: start.toDate(),
              timeZone: 'America/New_York'
            },
            end: {
              dateTime: end.toDate(),
              timeZone: 'America/New_York'
            },
            recurrence: [recurrence.toString()],
            extendedProperties: {
              private: {
                scheduledByLATE: true,
                courseID: course._id // links this event to the course
              }
            }
          }
        });
      }

      logger.debug(
        `Created recurring GCAL events for course '${course.title}' for ${
          ctx.state.user.rcs_id
        }`
      );
    }
  }
};

module.exports = {
  apis: google,
  createConnection,
  createUrl,
  actions
};
