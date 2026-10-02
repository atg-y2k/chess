# End User License Agreement (DRAFT)

> **DRAFT. NOT LEGAL ADVICE. HAVE A LAWYER REVIEW IT BEFORE YOU USE IT.**
>
> This is a starting point for the custom license agreement (EULA) that you paste into App Store
> Connect (**App Information → License Agreement → Edit**), and that `public/terms.html` shows at
> <https://atg-y2k.github.io/chess/terms.html> (the paywall links there as "Terms of Use (EULA)", and
> Menu → About as "Terms of Use"). `public/terms.html` also shows a visible "Draft" notice: remove it
> once the lawyer has signed off (`npm run check:legal` lists it with the placeholders).
> The two must say the same thing: if you change one, change the other.
>
> Why a custom EULA: Apple's Standard EULA says the buyer "may not transfer, redistribute or
> sublicense" the app, which conflicts with the GNU GPL that this app is under. This draft grants
> the license Apple requires for the App Store copy, says that the GPL governs the software, and
> adds no restrictions on GPL rights. Apple's minimum terms for a custom EULA
> (<https://www.apple.com/legal/internet-services/itunes/dev/minterms/>) are in sections 2 and 5–11.
> Whether this fully reconciles the App Store's terms with GPL section 10 is an open legal question
> (see the research notes in docs/APP_STORE.md, "Licensing").
>
> Before you publish it, fill in the placeholders in **both** files: `[YOUR LEGAL NAME]` (or your
> company's name), `[YOUR POSTAL ADDRESS]`, the email address (`chesscoach-support@example.com`),
> `[GOVERNING LAW]`, and the date. If you rename the app, replace "Chess Coach" too.
>
> Questions for the lawyer: whether section 2's Apple-required wording, section 9 (export
> compliance) or the trademark sentence in section 1 count as "further restrictions" under GPL
> section 10; the governing law and consumer-law wording for the countries you sell in; and
> whether an individual or a company (LLC) should be the party here.

---

**Chess Coach — End User License Agreement**

Last updated: October 2, 2026

This agreement (“Agreement”) is between you and [YOUR LEGAL NAME] (“we”, “us”), the developer of
the Chess Coach app (“the App”). It covers the copy of the App that you get from Apple’s App Store
and the in-app purchase in it. This Agreement is between you and us only, not with Apple, and we,
not Apple, are solely responsible for the App and its content.

## 1. The App is free software under the GNU GPL

The App is free software. You can redistribute it and/or modify it under the terms of the GNU
General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version (“GPL”). The App includes software by other authors
under the GPL, such as the Stockfish chess engine and the chessground board, and software under
other open-source licenses. The App lists them, with their license texts, under Menu → About.

- The complete source code of every App Store build is published at
  <https://github.com/atg-y2k/chess>. Menu → About in the App links to the exact source of the copy
  you have (a tag such as `ios-v1.0.0-b12`, or the commit it was built from), and each released
  version is also tagged with its version number (for example `v1.0.0`).
- Your rights to run, study, copy, modify and share the software come from the GPL. Nothing in this
  Agreement limits those rights. If anything in this Agreement conflicts with the GPL, the GPL
  prevails for the software.
- The GPL is a copyright license: it gives no rights to use our app name or icon as trademarks. If
  you publish a modified version, please give it a different name and icon.

## 2. Your license to use the App Store copy

In addition to your rights under the GPL, we grant you a non-transferable license to use the App
Store copy of the App on any Apple-branded products that you own or control, as permitted by the
Usage Rules in Apple’s Media Services Terms and Conditions, except that the App may also be used by
other accounts associated with you through Family Sharing. This section adds to your rights under
the GPL. It does not take any of them away.

## 3. Pro (in-app purchase)

Pro is a one-time, non-consumable in-app purchase that unlocks more coaching features in the App.
It is not a subscription. The price is shown in the App before you buy. Apple processes the payment
and handles refunds under its own policies. Pro is shared with the members of your Family Sharing
group. Buying Pro does not change your rights under the GPL.

## 4. Privacy

The App does not collect any personal data. Your games, rating and settings stay on your device.
Our Privacy Policy is at <https://atg-y2k.github.io/chess/privacy.html>.

## 5. No warranty

The App is provided “as is”, without warranty of any kind, to the extent permitted by applicable
law, as described in sections 15 and 16 of the GPL. The App’s move ratings, evaluations, advice and
player ratings are computer estimates. They can be wrong, and the ratings are not official (for
example FIDE) ratings.

If the App fails to conform to any applicable warranty, you may notify Apple, and Apple will refund
the purchase price you paid, if any. To the maximum extent permitted by applicable law, Apple has no
other warranty obligation with respect to the App. Any other claims, losses, liabilities, damages,
costs or expenses attributable to any failure to conform to any warranty are our responsibility, to
the extent they are not disclaimed in this Agreement.

Nothing in this Agreement limits rights you have under consumer protection laws that cannot be
waived or limited by contract.

## 6. Limitation of liability

To the extent permitted by applicable law, we are not liable for any damages arising out of the use
of, or the inability to use, the App, as described in section 16 of the GPL.

## 7. Maintenance and support

We, not Apple, are solely responsible for providing maintenance and support for the App, as
described at <https://atg-y2k.github.io/chess/support.html>. Apple has no obligation whatsoever to
furnish any maintenance or support services for the App.

## 8. Claims

We, not Apple, are responsible for addressing any claims by you or any third party relating to the
App or your possession and use of it, including: (i) product liability claims; (ii) any claim that
the App fails to conform to any applicable legal or regulatory requirement; and (iii) claims arising
under consumer protection, privacy or similar legislation. If a third party claims that the App or
your possession and use of it infringes that third party’s intellectual property rights, we, not
Apple, are solely responsible for the investigation, defense, settlement and discharge of that
claim.

## 9. Legal compliance

You represent and warrant that (i) you are not located in a country that is subject to a U.S.
Government embargo, or that has been designated by the U.S. Government as a “terrorist supporting”
country; and (ii) you are not listed on any U.S. Government list of prohibited or restricted
parties.

## 10. Third-party terms

When you use the App, you must comply with any third-party terms that apply to you, for example
your wireless data service agreement.

## 11. Apple as a third-party beneficiary

Apple and Apple’s subsidiaries are third-party beneficiaries of this Agreement. Once you accept this
Agreement, Apple will have the right (and will be deemed to have accepted the right) to enforce this
Agreement against you as a third-party beneficiary.

## 12. Governing law and changes

This Agreement is governed by [GOVERNING LAW], except where the law of the country you live in
requires otherwise. We may update this Agreement for future versions of the App and will post the
current version at <https://atg-y2k.github.io/chess/terms.html>.

## 13. Contact

Questions, complaints or claims about the App:

- [YOUR LEGAL NAME]
- [YOUR POSTAL ADDRESS]
- Email: chesscoach-support@example.com
- Support: <https://atg-y2k.github.io/chess/support.html>
