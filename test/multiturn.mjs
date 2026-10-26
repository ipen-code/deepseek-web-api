import { complete, createSession } from '../src/client.mjs';

// Multi-turn on one session: turn 2 must remember turn 1.
const sessionId = await createSession();
console.log('session', sessionId);

const t1 = await complete({ chatSessionId: sessionId, prompt: 'My name is Ada. Reply with just "noted".' });
console.log(`turn1 msgId=${t1.messageId} text=${JSON.stringify(t1.text)}`);

const t2 = await complete({
  chatSessionId: sessionId,
  parentMessageId: t1.messageId,
  prompt: 'What is my name? Reply with the name only.',
});
console.log(`turn2 msgId=${t2.messageId} text=${JSON.stringify(t2.text)}`);

const ok = /ada/i.test(t2.text);
console.log(ok ? 'PASS multi-turn memory' : 'FAIL multi-turn memory');
