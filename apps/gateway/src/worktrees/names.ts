const ADJECTIVES = [
  'amber',
  'bold',
  'brave',
  'bright',
  'brisk',
  'calm',
  'clever',
  'cosmic',
  'crisp',
  'curious',
  'daring',
  'eager',
  'fancy',
  'fleet',
  'gentle',
  'golden',
  'happy',
  'hidden',
  'jolly',
  'keen',
  'kind',
  'lively',
  'lucky',
  'merry',
  'mighty',
  'misty',
  'noble',
  'patient',
  'plucky',
  'proud',
  'quick',
  'quiet',
  'rapid',
  'rustic',
  'silent',
  'smooth',
  'steady',
  'sunny',
  'swift',
  'witty',
  'young',
  'zesty',
];

const ANIMALS = [
  'badger',
  'beaver',
  'bison',
  'camel',
  'condor',
  'coyote',
  'crane',
  'dingo',
  'dolphin',
  'eagle',
  'falcon',
  'ferret',
  'finch',
  'fox',
  'gecko',
  'heron',
  'ibis',
  'jaguar',
  'koala',
  'lemur',
  'lynx',
  'marten',
  'moose',
  'newt',
  'ocelot',
  'otter',
  'owl',
  'panda',
  'puffin',
  'quail',
  'rabbit',
  'raven',
  'robin',
  'salmon',
  'seal',
  'sparrow',
  'stoat',
  'swan',
  'tiger',
  'walrus',
  'weasel',
  'wombat',
];

const DRAWS = 5;

/**
 * An adjective-animal name no live worktree of the conversation uses. Five fresh draws come first;
 * after that a numeric suffix (`-2`, `-3`, ...) guarantees the search ends.
 */
export async function randomName(
  taken: (name: string) => boolean | Promise<boolean>,
  random: () => number = Math.random,
): Promise<string> {
  const pick = (list: string[]) => list[Math.floor(random() * list.length) % list.length];
  let name = '';

  for (let draw = 0; draw < DRAWS; draw += 1) {
    name = `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
    if (!(await taken(name))) return name;
  }

  for (let suffix = 2; ; suffix += 1) {
    if (!(await taken(`${name}-${suffix}`))) return `${name}-${suffix}`;
  }
}
