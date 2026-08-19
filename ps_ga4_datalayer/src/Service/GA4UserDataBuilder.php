<?php

declare(strict_types=1);

namespace PsGa4DataLayer\Service;

use Address;
use Context;
use Country;
use Customer;
use Order;
use PrestaShopLogger;
use Throwable;

/**
 * Builds GA4 first-party user data: the `user_id`, `user_properties`, and
 * the hashed `user_data` block used for user-provided data (UPD, a.k.a.
 * enhanced conversions).
 *
 * These are the three items GA4's own "Add first-party data" checklist
 * asks for, and they matter more every year as third-party cookies and
 * client-side signals degrade: `user_id` is what stitches sessions across
 * devices, and UPD is what lets Google match a conversion when the cookie
 * is missing.
 *
 * PRIVACY - read before changing anything here:
 *  - `user_id` is the PrestaShop customer id, an opaque internal number.
 *    It is NOT an email address. Google forbids sending PII (emails,
 *    names, phone numbers) as user_id, so nothing else may be used.
 *  - Everything in `user_data` is SHA-256 hashed before it leaves the
 *    server, per Google's UPD spec, and the feature is opt-in (off by
 *    default) because hashed contact data is still personal data under
 *    GDPR and needs a lawful basis plus consent.
 *  - Nothing here is ever pushed for a guest/anonymous visitor.
 */
final class GA4UserDataBuilder
{
    private Context $context;

    public function __construct(Context $context)
    {
        $this->context = $context;
    }

    /**
     * The stable cross-device/cross-session identifier.
     *
     * Returned as a string because GA4 treats user_id as a string
     * dimension; sending it as a number invites type drift in GTM.
     */
    public function userId(?Customer $customer = null): ?string
    {
        $customer = $customer ?? $this->currentCustomer();

        if ($customer === null || !$customer->id) {
            return null;
        }

        return (string) $customer->id;
    }

    /**
     * GA4 `user_properties` - low-cardinality, non-PII attributes useful
     * for audience building and reporting comparisons.
     *
     * @return array<string, mixed>
     */
    public function userProperties(?Customer $customer = null): array
    {
        $customer = $customer ?? $this->currentCustomer();

        $properties = [
            'logged_in' => $customer !== null && (int) $customer->id > 0 ? 'yes' : 'no',
        ];

        if ($customer === null || !$customer->id) {
            return $properties;
        }

        $properties['customer_type'] = $this->customerType((int) $customer->id);

        $group = $this->customerGroupName($customer);
        if ($group !== null) {
            $properties['customer_group'] = $group;
        }

        if (isset($customer->newsletter)) {
            $properties['newsletter_subscriber'] = ((int) $customer->newsletter === 1) ? 'yes' : 'no';
        }

        return $properties;
    }

    /**
     * Hashed user-provided data for GA4/Google Ads enhanced conversions.
     *
     * Shape follows Google's GTM user-provided data spec: contact fields
     * are SHA-256 hex digests of NORMALISED values, while the coarse
     * address components (city/region/postcode/country) are sent in the
     * clear, as Google specifies.
     *
     * @return array<string, mixed> empty when there is nothing to send
     */
    public function userData(?Customer $customer = null, ?Address $address = null): array
    {
        $customer = $customer ?? $this->currentCustomer();

        if ($customer === null || !$customer->id) {
            return [];
        }

        $data = [];

        $email = $this->hashEmail((string) ($customer->email ?? ''));
        if ($email !== null) {
            $data['sha256_email_address'] = $email;
        }

        $address = $address ?? $this->defaultAddress($customer);

        $phone = null;
        if ($address !== null) {
            $phone = $this->hashPhone(
                (string) ($address->phone_mobile ?: $address->phone ?: ''),
                (int) $address->id_country
            );
        }
        if ($phone !== null) {
            $data['sha256_phone_number'] = $phone;
        }

        $addressBlock = $this->addressBlock($customer, $address);
        if ($addressBlock !== []) {
            $data['address'] = $addressBlock;
        }

        return $data;
    }

    /**
     * @return array<string, string>
     */
    private function addressBlock(Customer $customer, ?Address $address): array
    {
        $block = [];

        $firstName = $this->hashName((string) ($address->firstname ?? $customer->firstname ?? ''));
        if ($firstName !== null) {
            $block['sha256_first_name'] = $firstName;
        }

        $lastName = $this->hashName((string) ($address->lastname ?? $customer->lastname ?? ''));
        if ($lastName !== null) {
            $block['sha256_last_name'] = $lastName;
        }

        if ($address === null) {
            return $block;
        }

        // Google expects these unhashed.
        $city = $this->normaliseText((string) ($address->city ?? ''));
        if ($city !== '') {
            $block['city'] = $city;
        }

        $postcode = $this->normaliseText((string) ($address->postcode ?? ''));
        if ($postcode !== '') {
            $block['postal_code'] = $postcode;
        }

        $country = $this->countryIso((int) ($address->id_country ?? 0));
        if ($country !== null) {
            $block['country'] = $country;
        }

        return $block;
    }

    /* ================================================================== *
     *  Normalisation + hashing (Google's UPD rules)
     * ================================================================== */

    /**
     * Email: trim, lowercase. Gmail/googlemail addresses additionally have
     * dots stripped from the local part, since Google treats them as
     * equivalent and normalising improves match rates.
     */
    public function hashEmail(string $email): ?string
    {
        $email = strtolower(trim($email));

        if ($email === '' || strpos($email, '@') === false) {
            return null;
        }

        [$local, $domain] = explode('@', $email, 2);

        if (in_array($domain, ['gmail.com', 'googlemail.com'], true)) {
            $local = str_replace('.', '', $local);
        }

        return $this->sha256($local . '@' . $domain);
    }

    /**
     * Phone: Google requires E.164 (leading +, country code, digits only).
     *
     * A national-format number cannot be converted without knowing its
     * country, so the address's country dialling prefix is used when the
     * number has no explicit prefix. When neither is available the number
     * is skipped rather than sent in a format Google would silently fail
     * to match.
     */
    public function hashPhone(string $phone, int $idCountry = 0): ?string
    {
        $phone = trim($phone);
        if ($phone === '') {
            return null;
        }

        $hasPlus = strpos($phone, '+') === 0;
        $digits = preg_replace('/\D+/', '', $phone) ?? '';

        if ($digits === '') {
            return null;
        }

        if (!$hasPlus) {
            $prefix = $this->countryCallingPrefix($idCountry);
            if ($prefix === null) {
                return null;
            }
            $digits = $prefix . ltrim($digits, '0');
        }

        return $this->sha256('+' . $digits);
    }

    /** Names: trim + lowercase, per Google's normalisation rules. */
    public function hashName(string $name): ?string
    {
        $name = $this->normaliseText($name);

        return $name === '' ? null : $this->sha256($name);
    }

    public function normaliseText(string $value): string
    {
        return strtolower(trim($value));
    }

    public function sha256(string $value): string
    {
        return hash('sha256', $value);
    }

    /* ================================================================== *
     *  PrestaShop lookups
     * ================================================================== */

    private function currentCustomer(): ?Customer
    {
        try {
            $customer = $this->context->customer ?? null;
            if ($customer instanceof Customer && $customer->id && $customer->isLogged()) {
                return $customer;
            }
        } catch (Throwable $e) {
            $this->logWarning('currentCustomer', $e);
        }

        return null;
    }

    /** 'new' before the first validated order, 'returning' after. */
    private function customerType(int $idCustomer): string
    {
        try {
            return ((int) Order::getCustomerNbOrders($idCustomer)) > 0 ? 'returning' : 'new';
        } catch (Throwable $e) {
            $this->logWarning('customerType', $e);

            return 'new';
        }
    }

    private function customerGroupName(Customer $customer): ?string
    {
        try {
            $idGroup = (int) ($customer->id_default_group ?? 0);
            if ($idGroup <= 0) {
                return null;
            }

            $group = new \Group($idGroup, (int) $this->context->language->id);
            $name = is_array($group->name) ? reset($group->name) : $group->name;
            $name = trim((string) $name);

            return $name !== '' ? $name : null;
        } catch (Throwable $e) {
            $this->logWarning('customerGroupName', $e);

            return null;
        }
    }

    private function defaultAddress(Customer $customer): ?Address
    {
        try {
            $addresses = $customer->getAddresses((int) $this->context->language->id);
            if (!is_array($addresses) || $addresses === []) {
                return null;
            }

            $first = reset($addresses);
            if (!is_array($first) || empty($first['id_address'])) {
                return null;
            }

            return new Address((int) $first['id_address']);
        } catch (Throwable $e) {
            $this->logWarning('defaultAddress', $e);

            return null;
        }
    }

    private function countryIso(int $idCountry): ?string
    {
        if ($idCountry <= 0) {
            return null;
        }

        try {
            $iso = Country::getIsoById($idCountry);

            return $iso ? strtolower((string) $iso) : null;
        } catch (Throwable $e) {
            $this->logWarning('countryIso', $e);

            return null;
        }
    }

    /**
     * Minimal ISO-3166 -> E.164 calling-code map, covering the countries a
     * PrestaShop shop is most likely to ship to. Unknown countries return
     * null, which skips the phone rather than guessing wrong.
     */
    private function countryCallingPrefix(int $idCountry): ?string
    {
        $iso = $this->countryIso($idCountry);
        if ($iso === null) {
            return null;
        }

        $prefixes = [
            'at' => '43', 'au' => '61', 'be' => '32', 'bg' => '359', 'br' => '55',
            'ca' => '1', 'ch' => '41', 'cn' => '86', 'cy' => '357', 'cz' => '420',
            'de' => '49', 'dk' => '45', 'ee' => '372', 'es' => '34', 'fi' => '358',
            'fr' => '33', 'gb' => '44', 'gr' => '30', 'hr' => '385', 'hu' => '36',
            'ie' => '353', 'in' => '91', 'it' => '39', 'jp' => '81', 'lt' => '370',
            'lu' => '352', 'lv' => '371', 'mt' => '356', 'mx' => '52', 'nl' => '31',
            'no' => '47', 'nz' => '64', 'pl' => '48', 'pt' => '351', 'ro' => '40',
            'rs' => '381', 'se' => '46', 'si' => '386', 'sk' => '421', 'tr' => '90',
            'ua' => '380', 'us' => '1', 'za' => '27',
        ];

        return $prefixes[$iso] ?? null;
    }

    private function logWarning(string $context, Throwable $e): void
    {
        try {
            if (class_exists(PrestaShopLogger::class)) {
                PrestaShopLogger::addLog(
                    sprintf('[ps_ga4_datalayer] GA4UserDataBuilder::%s - %s', $context, $e->getMessage()),
                    2,
                    null,
                    'GA4UserDataBuilder',
                    0,
                    true
                );
            }
        } catch (Throwable $loggingFailure) {
            // See the note in Ps_ga4_datalayer::logWarning().
        }
    }
}
