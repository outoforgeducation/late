const moment = require('moment');
const logger = require('../../modules/logger');

const { compileWeeklyOpenSchedule } = require('../../modules/auto_allocate');

const Block = require('../blocks/blocks.model');
const Assignment = require('./assignments.model');
const Student = require('../students/students.model');
const Unavailability = require('../unavailabilities/unavailabilities.model');

async function getAssignmentMiddleware (ctx, next) {
  const assignmentID = ctx.params.assignmentID;

  let assignment;
  try {
    assignment = await Assignment.findOne({
      _id: assignmentID,
      $or: [
        { _student: ctx.state.user._id },
        { shared: true, sharedWith: ctx.state.user.rcs_id }
      ]
    })
      .populate('_blocks')
      .populate('_student', '_id rcs_id name grad_year')
      .populate('comments._student', '_id rcs_id name grad_year');
  } catch (e) {
    logger.error(
      `Error getting assignment ${assignmentID} for ${
        ctx.state.user.rcs_id
      }: ${e}`
    );
    return ctx.internalServerError(
      'There was an error getting the assignment.'
    );
  }

  if (!assignment) {
    logger.error(
      `Failed to find assignment with ID ${assignmentID} for ${
        ctx.state.user.rcs_id
      }.`
    );
    return ctx.notFound('Could not find assignment.');
  }

  ctx.state.assignment = assignment;
  ctx.state.isAssignmentOwner = assignment._id === ctx.state.user._id;

  await next();
}

/**
 * Returns a list of all assignments with optional dueOn or dueBy filters.
 * start and end are optional URL query options in YYYY-MM-DD format.
 *
 * GET /assignments
 * @param {Koa context} ctx
 * @returns The array of assignments
 */
async function getAssignments (ctx) {
  let assignments;

  try {
    assignments = await ctx.state.user.getAssignments(
      ctx.query.start,
      ctx.query.end,
      ctx.query.title,
      ctx.query.courseCRN
    );
  } catch (e) {
    logger.error(
      `Failed to send assignments to ${ctx.state.user.rcs_id}: ${e}`
    );
    return ctx.internalServerError(
      'There was an error getting your assignments.'
    );
  }

  logger.info(`Sending assignments to ${ctx.state.user.rcs_id}`);

  ctx.ok({
    assignments
  });
}

/**
 * Given an assignment ID, return the assignment only if it belongs to the logged in user.
 *
 * GET /assignments/a/:assignmentID
 * @param {Koa context} ctx
 * @returns The assignment
 */
async function getAssignment (ctx) {
  const assignmentID = ctx.params.assignmentID;
  logger.info(`Sending assignment ${assignmentID} to ${ctx.state.user.rcs_id}`);

  ctx.ok({
    assessment: ctx.state.assignment,
    assignment: ctx.state.assignment
  });
}

/**
 * Given an assignment ID, return the assignment only if it belongs to the logged in user.
 *
 * GET /assignments/a/:assignmentID
 * @param {Koa context} ctx
 * @returns The assignment
 */
async function getAssignmentCollaboratorInfo (ctx) {
  if (!ctx.state.assignment.shared) {
    return ctx.badRequest('This assignment is not shared.');
  }

  const assignmentID = ctx.params.assignmentID;
  logger.info(
    `Sending assignment ${assignmentID} collaborator info to ${
      ctx.state.user.rcs_id
    }`
  );

  const unavailabilities = {};
  const collaborators = await Student.find({
    rcs_id: { $in: ctx.state.assignment.sharedWith }
  });
  for (let collaborator of collaborators) {
    unavailabilities[collaborator.rcs_id] = await Unavailability.find({
      _student: collaborator._id,
      termCode: ctx.session.currentTerm.code
    });
  }

  ctx.ok({
    collaborators,
    unavailabilities
  });
}

/**
 * Create an assignment given the assignment properies in the request body.
 * Request body:
 *  - title, description, dueDate, course_crn, time_estimate, priority
 *
 * POST /assignments
 * @param {Koa context} ctx
 * @returns The created assignment
 */
async function createAssignment (ctx) {
  const body = ctx.request.body;
  const due = moment(body.dueDate);

  // Limit to this semester
  if (
    !due.isBetween(ctx.session.currentTerm.start, ctx.session.currentTerm.end)
  ) {
    logger.error(
      `${
        ctx.state.user.rcs_id
      } tried to add assignment outside of current semester.`
    );
    return ctx.badRequest(
      'You cannot add an assignment due outisde of this semester.'
    );
  }
  const assignmentData = {
    _student: ctx.state.user,
    title: body.title,
    description: body.description,
    dueDate: due.toDate(),
    courseCRN: body.courseCRN,
    timeEstimate: body.timeEstimate,
    timeRemaining: body.timeEstimate,
    priority: parseInt(body.priority, 10),
    isRecurring: body.isRecurring
  };
  const newAssignment = new Assignment(assignmentData);

  // AUTO WORK-BLOCK ALLOCATION
  // const openSchedule = compileWeeklyOpenSchedule(
  //   ctx.session.currentTerm,
  //   ctx.state.user
  // );

  // // Create work blocks of max size 60 minutes (TODO: Make customizable)

  // // Loop through days from now until assignment due date
  // const daysUntilDue = due.diff(new Date(), 'days');
  // const today = moment().day();

  // console.log(daysUntilDue);

  // let minutesLeft = body.timeEstimate * 60;
  // for (let d = 0; d < Math.abs(10); d++) {
  //   if (minutesLeft === 0) break;

  //   const day = (d + today) % 7; // Get day of the week
  //   const openBlocksThatDay = openSchedule.filter(p => p.day === day);

  //   // Loop through open blocks
  //   for (let p of openBlocksThatDay) {
  //     const duration = Math.min(p.duration, 60); // Limit to 60 minutes
  //     const startTime = moment(p.start, 'HH:mm', true).add(d, 'days');
  //     const endTime = moment(startTime).add(duration, 'minutes');

  //     const newBlock = new Block({
  //       _student: ctx.state.user._id,
  //       startTime,
  //       endTime
  //     });
  //     newBlock.save();

  //     newAssignment._blocks.push(newBlock);
  //     minutesLeft -= duration;
  //     if (minutesLeft === 0) break;
  //   }
  // }
  // --------------------------
  let recurringAssignments = [];
  try {
    await newAssignment.save();

    if (body.isRecurring) {
      // Create all assignments every week up until end of classes in current semester
      logger.info('Creating recurring assignments...');

      // For other days of the week
      for (let dayIndex of body.recurringDays) {
        const nextFirst = moment(due).add(1, 'day');
        while (nextFirst.day() !== dayIndex) {
          nextFirst.add(1, 'day');
        }

        // For day of week of actual assignment
        while (nextFirst.isBefore(ctx.session.currentTerm.classesEnd)) {
          const recurringAssignment = new Assignment({
            ...assignmentData,
            _recurringOriginal: newAssignment._id,
            dueDate: nextFirst
          });
          await recurringAssignment.save();
          recurringAssignments.push(recurringAssignment);

          nextFirst.add(1, 'week');
        }
      }
    }
  } catch (e) {
    // mapping schema fields to form fields
    const errMap = {
      title: 'title',
      description: 'description',
      dueDate: 'due_date',
      course: 'course_id',
      timeEstimate: 'time_estimate',
      timeRemaining: 'time_estimate',
      priority: 'priority'
    };
    const errors = [];
    for (const key in e.errors) {
      errors.push(errMap[key]);
    }

    logger.error(
      `Failed to create new assignment for ${ctx.state.user.rcs_id}: ${e}`
    );

    return ctx.badRequest({
      errors
    });
  }

  logger.info(
    `Created new assigment '${newAssignment.title}' for ${
      ctx.state.user.rcs_id
    }`
  );

  ctx.created({
    createdAssessment: newAssignment,
    createdAssignment: newAssignment,
    recurringAssignments
  });
}

/**
 * Edit assignment given assignmentID and properties to update. Assignment ID is passed as request param.
 * Request body:
 * - updates: object of updates to the assignment in the form of the assignment schema, e.g. { title: 'New Title', description: 'New desc.' }
 *
 * PATCH /assignments/a/:assignmentID
 * @param {Koa context} ctx
 * @returns The updated assignment
 */
async function editAssignment (ctx) {
  const assignmentID = ctx.params.assignmentID;
  const updates = ctx.request.body;

  // const allowedProperties = [
  //   '_id',
  //   'title',
  //   'description',
  //   'dueDate',
  //   'courseCRN',
  //   'timeEstimate',
  //   'priority'
  // ];

  // // Ensure no unallowed properties are passed to update
  // if (Object.keys(updates).some(prop => !allowedProperties.includes(prop))) {
  //   logger.error(
  //     `Failed to update assignment for ${
  //       ctx.state.user.rcs_id
  //     } because of invalid update properties.`
  //   );
  //   return ctx.badRequest('Passed unallowed properties.');
  // }

  // Limit to this semester
  if (
    !moment(updates.dueDate).isBetween(
      ctx.session.currentTerm.start,
      ctx.session.currentTerm.end
    )
  ) {
    logger.error(
      `${
        ctx.state.user.rcs_id
      } tried to set assignment outside of current semester.`
    );
    return ctx.badRequest(
      'You cannot set an assignment due outisde of this semester.'
    );
  }

  // Update assignment
  ctx.state.assignment.set(updates);

  try {
    await ctx.state.assignment.save();
  } catch (e) {
    logger.error(
      `Failed to update assignment ${assignmentID} for ${
        ctx.state.user.rcs_id
      }: ${e}`
    );
    return ctx.badRequest('There was an error updating the assignment.');
  }

  logger.info(
    `Updated assignment ${ctx.state.assignment._id} for ${
      ctx.state.user.rcs_id
    }.`
  );

  ctx.ok({
    updatedAssessment: ctx.state.assignment,
    updatedAssignment: ctx.state.assignment
  });
}

/**
 * Toggle an assignment's completion status. The assignment ID is passed in the request params.
 *
 * POST /assignments/a/:assignmentID/toggle
 * @param {Koa context} ctx
 * @returns The updated assignment
 */
async function toggleAssignment (ctx) {
  const assignmentID = ctx.params.assignmentID;

  // Toggle completed status
  ctx.state.assignment.completed = !ctx.state.assignment.completed;
  ctx.state.assignment.completedAt = ctx.state.assignment.completed
    ? moment().toDate()
    : null;

  // Readjust time estimate if completed
  if (ctx.state.assignment.completed) {
    ctx.state.assignment.timeEstimate =
      ctx.state.assignment._blocks
        .filter(b => b.endTime <= ctx.state.assignment.completedAt)
        .reduce((acc, b) => acc + b.duration, 0) / 60; // MUST BE IN HOURS
  }

  try {
    await ctx.state.assignment.save();
  } catch (e) {
    logger.error(`Failed to toggle assignment with ID ${assignmentID}: ${e}`);
    return ctx.badRequest('There was an error toggling the assignment.');
  }

  logger.info(
    `Set assigment ${ctx.state.assignment._id} completion status to ${
      ctx.state.assignment.completed
    } for ${ctx.state.user.rcs_id}.`
  );

  ctx.ok({
    updatedAssessment: ctx.state.assignment,
    updatedAssignment: ctx.state.assignment
  });
}

/**
 * Given an assignment ID, remove the assignment only if it belongs to the logged in user.
 * The assignment should be in the params of the request.
 *
 * POST /assignments/a/:assignmentID/remove
 * @param {Koa context} ctx
 * @returns The removed assignment.
 */
async function deleteAssignment (ctx) {
  const assignmentID = ctx.params.assignmentID;

  if (!ctx.state.isAssignmentOwner) {
    logger.error(
      `Student ${
        ctx.state.user.rcs_id
      } tried to delete shared assignment ${assignmentID}`
    );
    return ctx.forbidden(
      'You cannot delete shared assignments. Only the owner can!'
    );
  }
  // Delete assignment

  try {
    ctx.state.assignment.remove();
  } catch (e) {
    logger.error(`Failed to remove assignment with ID ${assignmentID}: ${e}`);
    return ctx.internalServerError(
      'There was an error removing the assignment.'
    );
  }

  logger.info(
    `Deleted assignment ${ctx.state.assignment._id} for ${
      ctx.state.user.rcs_id
    }`
  );

  let removedRecurringAssignments = [];
  if (ctx.request.query.removeRecurring) {
    const rootAssignmentID = ctx.state.assignment._recurringOriginal;
    const query = {
      _student: ctx.state.user._id,
      _recurringOriginal: rootAssignmentID
    };

    if (ctx.request.query.removeRecurring === 'future') {
      query.dueDate = { $gt: ctx.state.assignment.dueDate };
    }

    removedRecurringAssignments = await Assignment.find(query);

    // Delete all in series either past and future or just future
    for (let a of removedRecurringAssignments) a.remove();

    logger.info('Deleted recurring assignments');
  }

  ctx.ok({
    removedAssessment: ctx.state.assignment,
    removedAssignment: ctx.state.assignment,
    removedRecurringAssignments
  });
}

/* COMMENTS */
/**
 * Add a comment to an assignment. The request body should contain the following:
 * - comment: the text of the comment
 *
 * @param {Koa context} ctx
 * @returns The updated assignment
 */
async function addComment (ctx) {
  const assignmentID = ctx.params.assignmentID;
  const text = ctx.request.body.comment;

  // Add comment
  ctx.state.assignment.comments.push({
    _student: ctx.state.user,
    addedAt: new Date(),
    body: text
  });

  try {
    await ctx.state.assignment.save();
  } catch (e) {
    logger.error(
      `Failed to save assignment ${assignmentID} for ${
        ctx.state.user.rcs_id
      }: ${e}`
    );
    return ctx.badRequest('There was an error adding the comment.');
  }

  ctx.ok({
    updatedAssessment: ctx.state.assignment,
    updatedAssignment: ctx.state.assignment
  });
}

/**
 * Delete a comment on an assignment. The request url should contain the following:
 * - index: the index of the comment to delete
 *
 * @param {Koa context} ctx
 * @returns The updated assignment
 */
async function deleteComment (ctx) {
  const assignmentID = ctx.params.assignmentID;

  const index = ctx.params.commentIndex;
  if (!ctx.state.assignment.comments[index]) {
    logger.error(
      `Student ${
        ctx.state.user.rcs_id
      } tried to delete nonexistent comment on assignment ${assignmentID}`
    );
    return ctx.badRequest('Could not find the comment to delete!');
  }

  if (
    !ctx.state.assignment.comments[index]._student ||
    !ctx.state.assignment.comments[index]._student._id.equals(
      ctx.state.user._id
    )
  ) {
    logger.error(
      `Student ${
        ctx.state.user.rcs_id
      } tried to delete other students comment on assignment ${assignmentID}`
    );
    return ctx.forbidden('You cannot delete somebody else\'s comment!');
  }

  // Delete the comment by its index

  ctx.state.assignment.comments.splice(index, 1);

  try {
    await ctx.state.assignment.save();
  } catch (e) {
    logger.error(
      `Failed to save assignment ${assignmentID} for ${
        ctx.state.user.rcs_id
      }: ${e}`
    );
    return ctx.badRequest('There was an error adding the comment.');
  }

  ctx.ok({
    updatedAssessment: ctx.state.assignment,
    updatedAssignment: ctx.state.assignment
  });
}

module.exports = {
  getAssignmentMiddleware,
  getAssignments,
  getAssignment,
  getAssignmentCollaboratorInfo,
  createAssignment,
  toggleAssignment,
  editAssignment,
  deleteAssignment,
  addComment,
  deleteComment
};
