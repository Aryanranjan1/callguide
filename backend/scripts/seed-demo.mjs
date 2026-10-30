import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Client } from 'pg';

const marker = '[CALLGUIDE_DEMO_V1]';
const contacts = [
  ['Mira Solis', 'Northstar Ledger', 'Operations Director', 'next_step_agreed', 'completed', 4, 'The team wants a clearer month-end close workflow. Mira agreed to a discovery session next week.', '2026-11-05T15:00:00Z'],
  ['Theo Park', 'Juniper Fleetworks', 'Fleet Manager', 'follow_up', 'completed', 5, 'Theo asked for a short overview of dispatch reporting and will review it with the regional leads.', '2026-11-03T16:30:00Z'],
  ['Anika Vale', 'Copper Finch Foods', 'Finance Lead', 'agreed_to_receive_report', 'completed', 6, 'Anika requested a sample cost analysis by email before deciding on a longer discussion.', null],
  ['Rowan Ellis', 'Bright Harbor Studio', 'Managing Partner', 'interested', 'completed', 3, 'Rowan described inconsistent project margin tracking and asked how teams handle shared reporting.', null],
  ['Sana Idris', 'Morrowfield Supply', 'Procurement Manager', 'call_again', 'completed', 2, 'Sana was between meetings and requested a call later in the week.', '2026-11-02T10:00:00Z'],
  ['Calder Finch', 'Blue Orchard Mobility', 'IT Coordinator', 'wrong_person', 'completed', 2, 'Calder handles device support, not purchasing, and suggested contacting the business systems lead.', null],
  ['Inez Mercer', 'Paper Kite Learning', 'Office Manager', 'moved_company', 'completed', 2, 'Inez has left the organization and could not provide an updated contact.', null],
  ['Oren Bell', 'Redwood Circuit Works', 'Plant Controller', 'do_not_call', 'completed', 2, 'Oren clearly requested no further calls.', null],
  ['Lena Quill', 'Tidal Thread Apparel', 'Founder', null, 'in_progress', 5, 'Lena is comparing ways to consolidate inventory and sales reporting.', null],
  ['Dev Malik', 'Stonecrop Analytics', 'Revenue Operations Lead', null, 'in_progress', 3, 'Dev confirmed the right team but has not yet discussed reporting requirements.', null],
  ['Avery North', 'Cedar & Current', 'General Manager', 'not_interested', 'completed', 3, 'Avery is satisfied with the current process and declined a follow-up.', null],
  ['Nico Wren', 'Lantern Ridge Rentals', 'Portfolio Manager', 'next_step_agreed', 'completed', 7, 'Nico agreed to a short workflow review with the systems coordinator.', '2026-11-04T14:00:00Z'],
  ['Priya Moss', 'Silver Lark Medical', 'Clinic Administrator', 'follow_up', 'completed', 5, 'Priya wants to revisit the conversation after the quarterly staffing review.', '2026-11-12T13:00:00Z'],
  ['Jules Arden', 'Mosaic Vale Hardware', 'Sales Director', 'agreed_to_receive_report', 'completed', 6, 'Jules requested a fictional sample showing branch-level performance summaries.', null],
  ['Tamsin Reed', 'Kestrel Basin Works', 'Office Coordinator', null, 'in_progress', 1, 'The contact confirmed the company name; role and needs remain unverified.', null],
  ['Eli Navarro', 'Willow Metric Labs', 'Product Operations Lead', 'interested', 'completed', 5, 'Eli is interested in reducing manual handoffs and will bring a colleague to a follow-up.', '2026-11-06T17:00:00Z'],
  ['Freya Chen', 'Amberline Paper Co', 'Customer Care Manager', 'wrong_person', 'completed', 2, 'Freya suggested the finance operations team may own this process.', null],
  ['Dara Okafor', 'Cloudberry Transit', 'Dispatch Supervisor', 'call_again', 'completed', 3, 'Dara requested a call outside the morning dispatch window.', '2026-11-03T19:30:00Z'],
  ['Remy Shaw', 'Foxglove Foundry', 'Owner', 'no_contact_made', 'completed', 2, 'A fictional wrong number was reached; no prospect conversation took place.', null],
  ['Noor Patel', 'Maple Current Energy', 'Business Analyst', null, 'in_progress', 6, 'Noor is documenting the existing approval path and will confirm who should join a review.', null],
  ['Kit Rowan', 'Sunroom Parcel', 'Logistics Lead', 'follow_up', 'completed', 7, 'Kit agreed to share a sample process map before the next conversation.', '2026-11-09T11:30:00Z'],
  ['Esme Voss', 'Pineglass Commerce', 'Merchandising Manager', 'not_interested', 'completed', 3, 'Esme declined the proposed discussion and asked to close the conversation.', null],
  ['Rafi Stone', 'Little Comet Fabrication', 'Workshop Manager', null, 'in_progress', 4, 'Rafi outlined a recurring delay in reconciling material requests.', null],
  ['Willa Brooks', 'Driftwood Civic Design', 'Studio Administrator', 'information_requested', 'completed', 6, 'Willa requested a concise, fictional overview to pass to the studio director.', null],
  ['Samir Vale', 'Cloudline Garden Supply', 'Branch Operations Lead', 'next_step_agreed', 'completed', 8, 'Samir agreed that the regional team can review a sample workflow and follow up with questions.', '2026-11-10T15:30:00Z'],
];

const firstUuid = 0x10000000;
const uuidAt = (n) => `10000000-0000-4000-8000-${(firstUuid + n).toString(16).padStart(12, '0')}`;
const stamp = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { ca: process.env.DATABASE_SSL_CA?.replaceAll('\\n', '\n'), rejectUnauthorized: true },
  connectionTimeoutMillis: 10_000,
});

function requireDevelopmentConfirmation() {
  if (process.argv[2] !== '--confirm-development-database') throw new Error('Pass --confirm-development-database to seed explicitly.');
  if (process.env.NODE_ENV !== 'development') throw new Error('Refusing to seed unless NODE_ENV=development.');
  if (!process.env.DATABASE_URL || !process.env.DATABASE_SSL_CA) throw new Error('DATABASE_URL and DATABASE_SSL_CA are required.');
  const url = new URL(process.env.DATABASE_URL);
  if (!url.hostname.endsWith('.pooler.supabase.com') || url.pathname !== '/postgres') throw new Error('Refusing to seed an unrecognized Supabase pooler target.');
}

async function insertDemoCall(index, row) {
  const [contact_name, company_name, contact_role, final_outcome, status, reachedStages, note, callback] = row;
  const id = uuidAt(index + 1);
  const createdAt = stamp(index);
  const completedAt = status === 'completed' ? new Date(Date.now() - Math.max(0, index - 2) * 3_600_000).toISOString() : null;
  const finalNotes = status === 'completed' ? note : null;
  const dnc = final_outcome === 'do_not_call';
  await client.query(`INSERT INTO calls
    (id,contact_name,company_name,contact_role,call_purpose,initial_context,status,final_outcome,do_not_call_confirmed,final_notes,callback_at,started_at,completed_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
    ON CONFLICT (id) DO NOTHING`, [id, contact_name, company_name, contact_role,
      `${marker} Synthetic sales workflow demonstration`,
      `Fictional scenario: ${note}`, status, final_outcome, dnc, finalNotes, callback, createdAt, completedAt, createdAt]);

  const expected = await client.query('SELECT contact_name,company_name,call_purpose FROM calls WHERE id=$1', [id]);
  if (!expected.rows[0] || expected.rows[0].contact_name !== contact_name || expected.rows[0].company_name !== company_name || !expected.rows[0].call_purpose.startsWith(marker)) {
    throw new Error(`Deterministic demo ID collision at record ${index + 1}; transaction rolled back.`);
  }

  for (let stage = 1; stage <= reachedStages; stage += 1) {
    const stageId = uuidAt(100 + index * 10 + stage);
    const stageStatus = stage < reachedStages || status === 'completed' ? 'completed' : 'in_progress';
    const stageNote = stage === reachedStages ? note : `Fictional call notes for ${contact_name}; stage ${stage} confirmed without unsupported assumptions.`;
    await client.query(`INSERT INTO call_stage_results (id,call_id,stage_number,stage_status,structured_result,notes,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$7) ON CONFLICT (call_id,stage_number) DO NOTHING`,
    [stageId, id, stage, stageStatus, JSON.stringify({ interaction: stage === reachedStages && final_outcome === 'wrong_person' ? 'wrong_person' : 'conversation', demo: true }), stageNote, createdAt]);

    if (stage === reachedStages && index % 3 === 0) {
      const questionId = uuidAt(500 + index);
      await client.query(`INSERT INTO call_stage_questions (id,stage_result_id,question_text,source,asked,response,position,created_at,updated_at)
        VALUES ($1,$2,$3,'suggested',TRUE,$4,0,$5,$5) ON CONFLICT (stage_result_id,position) DO NOTHING`,
      [questionId, stageId, 'What part of the current workflow takes the most time?', note.slice(0, 500), createdAt]);
    }
  }

  if (status === 'completed' && index % 2 === 0) {
    const summaryId = uuidAt(700 + index);
    const summary = `Synthetic demo summary: ${contact_name} of ${company_name} discussed a fictional workflow scenario. ${note} Recorded outcome: ${final_outcome}.`;
    await client.query(`INSERT INTO call_summaries (id,call_id,summary_text,model_name,source_snapshot,source_hash,created_at)
      VALUES ($1,$2,$3,'local-demo-seed',$4::jsonb,NULL,$5) ON CONFLICT (id) DO NOTHING`,
    [summaryId, id, summary, JSON.stringify({ demo: true, version: 1, outcome: final_outcome }), createdAt]);
  }
}

async function main() {
  requireDevelopmentConfirmation();
  await client.connect();
  try {
    await client.query('BEGIN');
    const identity = await client.query("SELECT current_database() db,current_schema() schema,current_user role");
    if (identity.rows[0].db !== 'postgres' || identity.rows[0].schema !== 'public' || identity.rows[0].role !== 'postgres') throw new Error('Live database identity did not match the configured development target.');
    const tlsSocket = client.connection.stream;
    if (tlsSocket.encrypted !== true || tlsSocket.authorized !== true) throw new Error('TLS certificate verification is not active; refusing to seed.');
    for (let i = 0; i < contacts.length; i += 1) await insertDemoCall(i, contacts[i]);
    const demoIds = contacts.map((_, i) => uuidAt(i + 1));
    const verify = await client.query('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE id=ANY($1::uuid[]))::int AS demo FROM calls', [demoIds]);
    if (verify.rows[0].demo !== 25) throw new Error(`Expected 25 identifiable demo calls; found ${verify.rows[0].demo}.`);
    await client.query('COMMIT');
    const total = await client.query('SELECT COUNT(*)::int AS total FROM calls');
    console.log(JSON.stringify({database: identity.rows[0].db, schema: identity.rows[0].schema, tlsVerified: true, insertedOrAlreadyPresentDemoCalls: 25, identifiableDemoCalls: verify.rows[0].demo, totalCalls: total.rows[0].total, demoIdSetSha256: createHash('sha256').update(demoIds.join(',')).digest('hex')}, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(JSON.stringify({code: error.code || null, message: error.message})); process.exitCode = 1; });
