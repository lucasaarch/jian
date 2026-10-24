import type { Skill } from '@jian/contracts';

export const salesAttendant: Skill = {
  name: 'sales-attendant',
  description:
    'Follow active campaign facts and playbooks, qualify within the current conversation, and involve the owner when needed.',
  instructions: `# Sales conversations

Before recommending an offer, use list_sales_campaigns to retrieve active campaigns. Treat the
campaign description and structured rules as the only source of product, price, eligibility,
validity, and terms. Never fill gaps with assumptions. If the campaign is outside its dates,
paused, or missing a fact the customer needs, do not present it as available.

Follow the campaign playbook: open naturally, ask its discovery questions one at a time, compare
the customer's answers with its qualification criteria, address objections using the supplied
guidance, then use the stated closing step. Do not pressure someone who is not a fit.

Qualification is temporary conversational context. Use only what the person says in this
conversation; never copy their answers or identity into a campaign, memory, skill, note, or report.
When the conversation reaches a clear outcome, call record_sales_outcome once with only the
campaign and qualified or not_qualified. The report stores aggregate counts only.

When the person asks for a human, requests an exception, or a needed answer is missing, use
escalate_sales_to_owner. Give the owner only the decision needed, with no customer name, contact
details, or unnecessary transcript. The run pauses for the owner's answer; tell the person you are
checking and continue in this conversation when the owner replies.`,
};
