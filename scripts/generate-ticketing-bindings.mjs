// Generates the committed TypeScript bindings for the ticketing contract.
//
// The canonical command is:
//   stellar contract bindings typescript \
//     --wasm ../blockchain/target/wasm32v1-none/release/ticketing.wasm \
//     --output-dir src/stellar/generated/ticketing
//
// The generator below produces the same SDK-shaped bindings from the contract's
// spec entries so the checked-in files can be refreshed without a Rust/WASM
// toolchain. It mirrors contracts/ticketing/src/{lib,types,error}.rs from
// StellarTickets/blockchain.

import { mkdir, writeFile } from 'node:fs/promises';
import { BindingGenerator, xdr } from '@stellar/stellar-sdk';
import { Spec } from '@stellar/stellar-sdk/contract';

const T = xdr.ScSpecTypeDef;
const voidT = () => T.scSpecTypeVoid();
const u32 = () => T.scSpecTypeU32();
const u64 = () => T.scSpecTypeU64();
const i128 = () => T.scSpecTypeI128();
const string = () => T.scSpecTypeString();
const address = () => T.scSpecTypeAddress();
const udt = (name) => T.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name }));
const opt = (t) => T.scSpecTypeOption(new xdr.ScSpecTypeOption({ valueType: t }));
const vec = (t) => T.scSpecTypeVec(new xdr.ScSpecTypeVec({ elementType: t }));

const field = (name, type, doc = '') =>
  new xdr.ScSpecUdtStructFieldV0({ doc, name, type });

const struct = (name, fields, doc = '') =>
  xdr.ScSpecEntry.scSpecEntryUdtStructV0(
    new xdr.ScSpecUdtStructV0({ doc, lib: '', name, fields }),
  );

const enumUdt = (name, cases, docs = {}) =>
  xdr.ScSpecEntry.scSpecEntryUdtEnumV0(
    new xdr.ScSpecUdtEnumV0({
      doc: '',
      lib: '',
      name,
      cases: cases.map(
        (c, i) =>
          new xdr.ScSpecUdtEnumCaseV0({ doc: docs[c] ?? '', name: c, value: i }),
      ),
    }),
  );

const errorEnum = (name, cases) =>
  xdr.ScSpecEntry.scSpecEntryUdtErrorEnumV0(
    new xdr.ScSpecUdtErrorEnumV0({
      doc: '',
      lib: '',
      name,
      cases: cases.map(
        ([c, value]) =>
          new xdr.ScSpecUdtErrorEnumCaseV0({ doc: '', name: c, value }),
      ),
    }),
  );

const input = (name, type, doc = '') =>
  new xdr.ScSpecFunctionInputV0({ doc, name, type });

const fn = (name, inputs, output, doc = '') =>
  xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc,
      name,
      inputs,
      outputs: output ? [output] : [],
    }),
  );

// From contracts/ticketing/src/error.rs.
const errorCases = [
  ['AlreadyInitialized', 1], ['NotInitialized', 2], ['EventNotFound', 3], ['EventAlreadyExists', 4],
  ['TicketNotFound', 5], ['NotOrganizer', 6], ['NotOwner', 7], ['AlreadyUsed', 8], ['Revoked', 9],
  ['NotForResale', 10], ['ResalePriceExceedsCap', 11], ['InvalidPrice', 12], ['InvalidRoyalty', 13],
  ['EscrowNotEnabled', 14], ['EventNotEnded', 15], ['PurchaseTooSoon', 16], ['NotAdmin', 17],
  ['EventAlreadyStarted', 18], ['InvalidEventTime', 19], ['TransfersFrozen', 20], ['ResaleClosed', 21],
  ['InvalidLottery', 22], ['GiftClaimNotFound', 23], ['GiftClaimExpired', 24], ['InvalidSecret', 25],
  ['InvalidExpiry', 26], ['EmptyBatch', 27], ['BatchTooLarge', 28], ['InvalidPaymentToken', 29],
  ['NoPendingPaymentToken', 30], ['TimelockNotElapsed', 31], ['TicketsAlreadyIssued', 32],
  ['TransferLimitExceeded', 33], ['ResalePriceBelowFloor', 34], ['TierPriceNotSet', 35],
  ['InvalidMultiplier', 36], ['EmptyNameOrCategory', 37], ['StringTooLong', 38], ['SelfTransfer', 39],
  ['SelfPurchase', 40], ['OrganizerNotApproved', 41], ['ResaleListingActive', 42],
  ['InvalidTicketLifecycle', 43], ['SamePaymentToken', 44], ['MathOverflow', 45], ['NotTransferable', 46],
  ['MetadataUriNotSet', 47], ['TicketNotUsed', 48], ['RetentionPeriodNotElapsed', 49], ['SoldOut', 50],
  ['InvalidCapacity', 51], ['CheckInWindowClosed', 52], ['InvalidCheckInWindow', 53], ['TicketExpired', 54],
  ['InvalidTicketExpiry', 55], ['ReentryNotAllowed', 56], ['ReentryLimitReached', 57], ['EventCancelled', 58],
  ['TierSoldOut', 59], ['InvalidMaxUses', 60], ['GiftClaimAlreadyExists', 66], ['ContractPaused', 67],
  ['RefundWindowExpired', 68], ['AlreadyRefunded', 69], ['PurchaseLimitExceeded', 70], ['NotOnAllowlist', 71],
  ['PresaleNotStarted', 72], ['PresaleEnded', 73], ['InvalidPlatformFee', 74], ['AuctionNotFound', 75],
  ['AuctionEnded', 76], ['AuctionNotEnded', 77], ['AuctionActive', 78], ['AuctionHasBids', 79],
  ['InvalidAuctionEnd', 80], ['BidTooLow', 81], ['OfferNotFound', 82], ['OfferAlreadyExists', 83],
  ['NotApproved', 84], ['ResaleFundsOutstanding', 85], ['ZoneNotAllowed', 86], ['InvalidZones', 87],
  ['SaleNotStarted', 88], ['SaleEnded', 89], ['InvalidSaleWindow', 90], ['TicketNotYetValid', 91],
  ['TicketValidityEnded', 92], ['InvalidValidityWindow', 93], ['InvalidPerks', 94], ['InvalidEventMetadata', 95],
  ['EventMetadataFull', 96], ['NoPendingAdmin', 97], ['NotPendingAdmin', 98],
];

const entries = [
  struct('EventParams', [
    field('name', string()), field('category', string()),
    field('max_resale_multiplier_bps', u32()), field('royalty_bps', u32()),
    field('starts_at', u64()), field('transfer_freeze_seconds', u64()),
    field('resale_cutoff_seconds', u64()), field('max_per_wallet', opt(u32())),
    field('refund_window_seconds', opt(u64())), field('presale_starts_at', opt(u64())),
    field('presale_ends_at', opt(u64())),
  ]),
  enumUdt('TicketStatus', ['Valid', 'Used', 'Revoked', 'Resale', 'Refunded']),
  struct('Ticket', [
    field('event_id', u64()), field('owner', address()), field('tier', string()),
    field('seat', string()), field('status', udt('TicketStatus')),
    field('original_price', i128()), field('resale_price', i128()),
    field('transfers', u32()), field('purchased_at', u64()),
  ]),
  struct('Event', [
    field('organizer', address()), field('name', string()), field('category', string()),
    field('max_resale_multiplier_bps', u32()), field('min_resale_multiplier_bps', opt(u32())),
    field('max_transfers_per_ticket', opt(u32())), field('royalty_bps', u32()),
    field('tickets_issued', u64()), field('starts_at', u64()),
    field('transfer_freeze_seconds', u64()), field('resale_cutoff_seconds', u64()),
    field('escrow_enabled', T.scSpecTypeBool()), field('escrow_release_ledger', u32()),
    field('escrow_balance', i128()), field('payment_token', opt(address())),
    field('transferable', T.scSpecTypeBool()), field('max_per_wallet', opt(u32())),
    field('refund_window_seconds', opt(u64())), field('presale_starts_at', opt(u64())),
    field('presale_ends_at', opt(u64())), field('max_tickets', opt(u64())),
    field('check_in_opens_seconds', opt(u64())), field('ends_at', opt(u64())),
    field('ticket_expires_at', opt(u64())), field('max_reentries', u32()),
    field('cancelled', T.scSpecTypeBool()),
    field('royalty_splits', opt(vec(T.scSpecTypeTuple(new xdr.ScSpecTypeTuple({ valueTypes: [address(), u32()] }))))),
  ]),
  errorEnum('Error', errorCases),
  fn('verify_ticket', [input('ticket_id', u64())], udt('Ticket')),
  fn('get_event', [input('event_id', u64())], udt('Event')),
  fn('create_event', [input('organizer', address()), input('event_id', u64()), input('params', udt('EventParams'))], null),
  fn('issue_ticket', [input('organizer', address()), input('event_id', u64()), input('to', address()), input('tier', string()), input('seat', string()), input('price', i128())], u64()),
  fn('purchase_primary', [input('buyer', address()), input('event_id', u64()), input('tier', string()), input('seat', string())], u64()),
  fn('transfer_ticket', [input('from', address()), input('ticket_id', u64()), input('to', address())], null),
  fn('check_in', [input('organizer', address()), input('ticket_id', u64())], null),
  fn('revoke_ticket', [input('organizer', address()), input('ticket_id', u64())], null),
  fn('revoke_batch', [input('organizer', address()), input('ticket_ids', vec(u64()))], null),
  fn('list_for_resale', [input('owner', address()), input('ticket_id', u64()), input('price', i128())], null),
  fn('cancel_resale', [input('owner', address()), input('ticket_id', u64())], null),
  fn('buy_resale', [input('buyer', address()), input('ticket_id', u64())], null),
];

const spec = new Spec(entries);
const bindings = BindingGenerator.fromSpec(spec).generate({ contractName: 'ticketing' });
const specBase64 = Buffer.concat(entries.map((e) => e.toXDR())).toString('base64');
const outDir = new URL('../src/stellar/generated/ticketing/', import.meta.url);

await mkdir(outDir, { recursive: true });
await Promise.all([
  writeFile(new URL('index.ts', outDir), bindings.index),
  writeFile(new URL('client.ts', outDir), bindings.client),
  writeFile(
    new URL('types.ts', outDir),
    // `as const` keeps every error name a literal type so mappings can be
    // checked for exhaustive coverage of the generated error enum.
    bindings.types.replace(
      /(export const Error = \{[\s\S]*?\n\})/,
      '$1 as const;',
    ),
  ),
  writeFile(
    new URL('spec.ts', outDir),
    `// Generated from the ticketing contract spec. Do not edit by hand.\nexport const SPEC = '${specBase64}';\n`,
  ),
]);
console.log('Wrote src/stellar/generated/ticketing/{index,client,types,spec}.ts');
