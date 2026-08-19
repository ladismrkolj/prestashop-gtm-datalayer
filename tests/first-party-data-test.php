<?php
/**
 * First-party data test - run with: php tests/first-party-data-test.php
 *
 * Covers GA4's "Add first-party data" surface: User-ID, user_properties
 * and user-provided data (UPD / enhanced conversions).
 *
 * The expected SHA-256 digests below were computed INDEPENDENTLY with
 * Python's hashlib, not with the code under test, so this is a real
 * cross-check of the normalisation rules rather than a tautology:
 *
 *   sha256("testuser@gmail.com") = dae9c7c5...
 *   sha256("+38612345678")       = 2ae83dfc...
 *   sha256("ada")                = fdee430d...
 *   sha256("lovelace")           = fb1e7ec9...
 *
 * Google's normalisation rules being asserted:
 *  - email: trim + lowercase, and for gmail/googlemail strip dots from the
 *    local part (Google treats them as the same mailbox);
 *  - phone: E.164 (+countrycode, digits only) - a national number is
 *    converted using the address country's dialling prefix, and skipped
 *    entirely if that cannot be determined, since a wrongly-formatted
 *    number silently fails to match rather than erroring;
 *  - names: trim + lowercase;
 *  - city / postal_code / country travel UNHASHED, per Google's spec.
 */

define('_PS_VERSION_', '9.0.0');

/* --------------------------- stubs --------------------------------- */

class Context {
    private static ?Context $i = null;
    public $customer; public $language; public $shop;
    public static function getContext() { return self::$i ??= new self(); }
}
class PrestaShopLogger {
    public static array $logs = [];
    public static function addLog($m, $sev = 1, $ec = null, $ot = null, $oi = null, $dup = false, $emp = null) { self::$logs[] = $m; }
}
class ObjectModelStub { public $id = null; }
class Customer extends ObjectModelStub {
    public $email; public $firstname = 'Ada'; public $lastname = 'Lovelace';
    public $newsletter = 1; public $id_default_group = 3;
    public bool $logged = true;
    public array $addressRows = [['id_address' => 55]];
    public function __construct($id = 7, $email = 'Test.User@Gmail.com') { $this->id = $id; $this->email = $email; }
    public function isLogged($withGuest = false) { return $this->logged; }
    public function getAddresses($idLang) { return $this->addressRows; }
}
class Group extends ObjectModelStub {
    public $name = 'Wholesale';
    public function __construct($id = null, $idLang = null) { $this->id = (int) $id; }
}
class Country extends ObjectModelStub {
    public static string $iso = 'SI';
    public static function getIsoById($id) { return static::$iso; }
}
class Address extends ObjectModelStub {
    public $firstname = 'Ada'; public $lastname = 'Lovelace'; public $city = ' Ljubljana ';
    public $postcode = '1000'; public $id_country = 1;
    public $phone = '01 234 5678'; public $phone_mobile = '';
    public function __construct($id = null) { $this->id = (int) $id; }
}
class Order extends ObjectModelStub {
    public static int $nbOrders = 2;
    public static function getCustomerNbOrders($idCustomer) { return static::$nbOrders; }
}

require_once __DIR__ . '/../ps_ga4_datalayer/src/Service/GA4UserDataBuilder.php';

use PsGa4DataLayer\Service\GA4UserDataBuilder;

/* --------------------------- harness -------------------------------- */

$failures = [];
function check(string $label, bool $ok, string $detail = ''): void {
    global $failures;
    if ($ok) { printf("  %-58s OK\n", $label); return; }
    $failures[] = $label . ($detail !== '' ? " ($detail)" : '');
    printf("  %-58s FAIL %s\n", $label, $detail);
}

$ctx = Context::getContext();
$ctx->language = new class extends ObjectModelStub { public $id = 1; };
$ctx->customer = new Customer();

$builder = new GA4UserDataBuilder($ctx);

/* ============================ User-ID ============================== */

echo "=== User-ID ===\n";
$userId = $builder->userId();
check('user_id is the customer id', $userId === '7', "got " . var_export($userId, true));
check('user_id is a string (GA4 dimension type)', is_string($userId));
check('user_id is NOT the email address', $userId !== null && strpos($userId, '@') === false);

/* ========================= user_properties ========================== */

echo "\n=== user_properties ===\n";
$props = $builder->userProperties();
check('logged_in reported', ($props['logged_in'] ?? null) === 'yes');
check('returning customer detected (has prior orders)', ($props['customer_type'] ?? null) === 'returning', json_encode($props));
check('customer group resolved', ($props['customer_group'] ?? null) === 'Wholesale');
check('newsletter status reported', ($props['newsletter_subscriber'] ?? null) === 'yes');
check('no PII in user_properties', strpos(json_encode($props), '@') === false);

Order::$nbOrders = 0;
$freshBuilder = new GA4UserDataBuilder($ctx);
check('first-time customer reported as new', ($freshBuilder->userProperties()['customer_type'] ?? null) === 'new');
Order::$nbOrders = 2;

/* ====================== user_data (hashed UPD) ====================== */

echo "\n=== user_data: hashing & normalisation ===\n";
$data = $builder->userData();

check(
    'email lowercased, gmail dots stripped, then SHA-256',
    ($data['sha256_email_address'] ?? null) === 'dae9c7c55697ba170d6b494c458649bd469af525520280d0dcfc98d74d13b17e',
    (string) ($data['sha256_email_address'] ?? 'missing')
);
check(
    'national phone converted to E.164 then SHA-256',
    ($data['sha256_phone_number'] ?? null) === '2ae83dfc55a87be78fee4fb998b589897f9083ed5bbd2001e22307d6c4511c4e',
    (string) ($data['sha256_phone_number'] ?? 'missing')
);
check(
    'first name lowercased then SHA-256',
    ($data['address']['sha256_first_name'] ?? null) === 'fdee430d40bd57deeac186cd9790033d0f06f909a8806e7ce6e717ab7c7d5029'
);
check(
    'last name lowercased then SHA-256',
    ($data['address']['sha256_last_name'] ?? null) === 'fb1e7ec987523d2cb9e022cec1d6ae7c99dc46edfae4fe51254025fe4bea571f'
);
check('city sent unhashed and trimmed/lowercased', ($data['address']['city'] ?? null) === 'ljubljana');
check('postal code sent unhashed', ($data['address']['postal_code'] ?? null) === '1000');
check('country sent as lowercase ISO', ($data['address']['country'] ?? null) === 'si');

// The critical privacy assertion: no raw contact data anywhere.
$encoded = json_encode($data);
check('no raw email in payload', strpos($encoded, '@') === false);
check('no raw name in payload', stripos($encoded, 'lovelace') === false);
check('no raw phone digits in payload', strpos($encoded, '234 5678') === false && strpos($encoded, '012345678') === false);

/* ==================== phone edge cases ============================== */

echo "\n=== phone normalisation edge cases ===\n";
check(
    'already-E.164 number is kept as-is',
    $builder->hashPhone('+386 1 234 5678', 0) === $builder->sha256('+38612345678')
);
check(
    'national number with unknown country is skipped, not guessed',
    $builder->hashPhone('01 234 5678', 0) === null,
    'sending a non-E.164 number would silently fail to match at Google'
);
check('empty phone yields null', $builder->hashPhone('', 1) === null);
check('non-numeric phone yields null', $builder->hashPhone('n/a', 1) === null);

echo "\n=== email edge cases ===\n";
check('non-gmail dots are preserved', $builder->hashEmail('first.last@example.com') === $builder->sha256('first.last@example.com'));
check('googlemail treated like gmail', $builder->hashEmail('a.b@googlemail.com') === $builder->sha256('ab@googlemail.com'));
check('whitespace and case normalised', $builder->hashEmail('  MiXeD@Example.COM ') === $builder->sha256('mixed@example.com'));
check('malformed address yields null', $builder->hashEmail('not-an-email') === null);
check('empty address yields null', $builder->hashEmail('') === null);

/* ==================== anonymous visitors ============================ */

echo "\n=== anonymous visitors send nothing ===\n";
$ctx->customer->logged = false;
$anon = new GA4UserDataBuilder($ctx);
check('no user_id for a logged-out visitor', $anon->userId() === null);
check('no user_data for a logged-out visitor', $anon->userData() === []);
check('logged_in reported as no', ($anon->userProperties()['logged_in'] ?? null) === 'no');
check('no customer_type leaked for anonymous', !isset($anon->userProperties()['customer_type']));
$ctx->customer->logged = true;

/* ==================== degraded data ================================= */

echo "\n=== degraded data does not throw ===\n";
$ctx->customer->addressRows = [];
$noAddr = new GA4UserDataBuilder($ctx);
$partial = $noAddr->userData();
check('customer with no address still yields hashed email', isset($partial['sha256_email_address']));
check('and no phone', !isset($partial['sha256_phone_number']));
check('names still present from the customer record', isset($partial['address']['sha256_first_name']));

echo "\n============================================\n";
if ($failures === []) {
    echo "RESULT: PASS - first-party data normalised, hashed and PII-free\n";
    exit(0);
}
echo 'RESULT: FAIL (' . count($failures) . ")\n";
foreach ($failures as $f) { echo " - $f\n"; }
exit(1);
