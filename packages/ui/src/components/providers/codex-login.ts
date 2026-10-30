/**
 * Starts the ChatGPT sign-in from the owner's click: the code goes to the clipboard and the
 * OpenAI page opens in a new tab. Copying needs this page focused, so it runs before the tab
 * takes the focus away. Either can be refused — a browser without clipboard access, a popup
 * blocker — which is why the dialog still shows both.
 */
export async function handOff(login: { verificationUrl?: string; userCode?: string }) {
  const copied = login.userCode
    ? await navigator.clipboard.writeText(login.userCode).then(
        () => true,
        () => false,
      )
    : false;

  if (login.verificationUrl) window.open(login.verificationUrl, '_blank', 'noopener,noreferrer');

  return copied;
}
