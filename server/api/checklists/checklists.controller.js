const Checklist = require('./checklists.model');
const logger = require('../../modules/logger');

/**
 * Get all non-private checklists.
 *
 * @param {Koa context} ctx
 */
async function getStudentChecklist (ctx) {
  let checklist;
  try {
    checklist = await Checklist.findOne({
      _student: ctx.state.user._id
    });
  } catch (e) {
    logger.error(`Failed to get checklist for ${ctx.state.user.rcs_id}: ${e}`);
    return ctx.badRequest('Could not find the checklist!');
  }

  logger.info(`Sending checklist to ${ctx.state.user.rcs_id}`);

  ctx.ok({
    checklist
  });
}

/**
 * Get a public checklist by its ID
 *
 * @param {Koa context} ctx
 */
async function getChecklist (ctx) {
  const { checklistID } = ctx.params;

  let checklist;
  try {
    checklist = await Checklist.findOne({
      _id: checklistID,
      private: false
    }).populate('_student', 'rcs_id name grad_year');
  } catch (e) {
    logger.error(`Failed to get checklist ${checklistID} for ${ctx.state.user.rcs_id}: ${e}`);
    return ctx.badRequest('Could not find the checklist!');
  }

  if (!checklist) return ctx.notFound('That checklist doesn\'t exist or isn\'t public!');

  logger.info(`Sending checklist ${checklistID} to ${ctx.state.user.rcs_id}`);

  ctx.ok({
    checklist
  });
}

async function createOrUpdateChecklist (ctx) {
  let checklist;
  try {
    checklist = await Checklist.findOne({
      _student: ctx.state.user._id
    });
  } catch (e) {
    logger.error(`Failed to get checklist for ${ctx.state.user.rcs_id}: ${e}`);
    return ctx.badRequest('Could not find the checklist!');
  }

  const updates = {
    _student: ctx.state.user._id,
    categories: ctx.request.body.categories,
    private: ctx.request.body.private
  };

  if (!checklist) {
    checklist = new Checklist({
      ...updates,
      _student: ctx.state.user._id
    });
  } else {
    Object.assign(checklist, updates);
  }

  try {
    await checklist.save();
  } catch (e) {
    logger.error(
      `Failed to update checklist for ${ctx.state.user.rcs_id}: ${e}`
    );
    return ctx.internalServerError('Failed to update the checklist!');
  }

  logger.info(`Saved checklist ${checklist._id} for ${ctx.state.user.rcs_id}`);

  return ctx.ok({
    updatedChecklist: checklist
  });
}

async function removeChecklist (ctx) {}

module.exports = {
  getStudentChecklist,
  getChecklist,
  createOrUpdateChecklist,
  removeChecklist
};
