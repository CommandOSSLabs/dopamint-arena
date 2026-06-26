import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface DnsOutputs {
  certificateArn?: pulumi.Output<string>;
  zoneId?: pulumi.Output<string>;
  domain: string;
}

export function createDns(
  name: string,
  args: { domain: string; route53ZoneId?: string; certificateArn?: string },
): DnsOutputs {
  if (args.certificateArn) {
    return {
      certificateArn: pulumi.output(args.certificateArn),
      domain: args.domain,
    };
  }

  const zone = args.route53ZoneId
    ? aws.route53.Zone.get(`${name}-zone`, args.route53ZoneId)
    : undefined;

  if (!zone) {
    return { domain: args.domain };
  }

  const certificate = new aws.acm.Certificate(`${name}-cert`, {
    domainName: args.domain,
    validationMethod: "DNS",
    subjectAlternativeNames: [`*.${args.domain}`],
  });

  const validationFqdns = certificate.domainValidationOptions.apply(
    (options) => {
      const records = options.map(
        (option, i) =>
          new aws.route53.Record(`${name}-cert-validation-${i}`, {
            zoneId: zone.zoneId,
            name: option.resourceRecordName,
            type: option.resourceRecordType,
            records: [option.resourceRecordValue],
            ttl: 60,
            allowOverwrite: true,
          }),
      );
      return pulumi.all(records.map((record) => record.fqdn));
    },
  );

  const validatedCert = new aws.acm.CertificateValidation(
    `${name}-cert-validated`,
    {
      certificateArn: certificate.arn,
      validationRecordFqdns: validationFqdns,
    },
  );

  return {
    certificateArn: validatedCert.certificateArn,
    zoneId: zone.zoneId,
    domain: args.domain,
  };
}
